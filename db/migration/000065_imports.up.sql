-- The importer (#150): a WordPress export (WXR) or a zip of Markdown files becomes posts,
-- pages, terms and media. The upload is parsed at once into a job (status 'mapping': the
-- admin matches authors and post types), then the job runs in the background
-- (RunImports, every replica) one item at a time, so a long import is never one request.
--
-- The import never writes Yjs state: each post gets block_doc only, and the collab server
-- seeds the live doc from it on first open (rule 11 in
-- web/gl-admin/lib/collaboration/CLAUDE.md, like POST /posts).

-- One upload. summary, terms, attachments and blocks are what the parse read (counts,
-- authors and post types for the mapping step; the export's terms; its attachments by
-- WordPress id; its reusable blocks); mapping is the admin's choice; term_ids the terms the
-- run made or found, so a resumed run doesn't redo them. lease_until/lease_token: the
-- worker's claim (2 minutes, renewed per item); the token is the fencing value every write
-- of the run checks, so a replica that lost the claim writes nothing.
CREATE TABLE "import_jobs" (
  "id"          bigserial   PRIMARY KEY,
  "created_by"  bigint      REFERENCES "users" ("id") ON DELETE SET NULL,
  "source"      text        NOT NULL CONSTRAINT import_jobs_source CHECK ("source" IN ('wxr', 'markdown')),
  "file_name"   text        NOT NULL CONSTRAINT import_jobs_file_name CHECK (char_length("file_name") <= 255),
  "site_url"    text        NOT NULL DEFAULT '',
  "status"      text        NOT NULL DEFAULT 'mapping'
    CONSTRAINT import_jobs_status CHECK ("status" IN ('mapping', 'queued', 'running', 'done', 'failed', 'cancelled')),
  "summary"     jsonb       NOT NULL DEFAULT '{}',
  "terms"       jsonb       NOT NULL DEFAULT '[]',
  "attachments" jsonb       NOT NULL DEFAULT '{}',
  "blocks"      jsonb       NOT NULL DEFAULT '{}',
  "mapping"     jsonb       NOT NULL DEFAULT '{}',
  "term_ids"    jsonb,
  "lease_until" timestamptz,
  "lease_token" bigint      NOT NULL DEFAULT 0,
  "error"       text        NOT NULL DEFAULT '',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "started_at"  timestamptz,
  "finished_at" timestamptz
);

-- The worker's claim: a queued job, or a running one whose lease ran out.
CREATE INDEX "import_jobs_runnable_idx" ON "import_jobs" ("id") WHERE "status" IN ('queued', 'running');

-- One post or page of the export, in import order (a page's parent before it). source_key
-- is the WordPress GUID (or the Markdown file's key): an item whose key was imported by an
-- earlier job, and whose post still exists, is skipped, so running a file again is
-- idempotent. payload is the parsed item (title, slug, status, date, body, terms, author,
-- featured image); result what the import did (dropped blocks with the original, notes,
-- images that failed, the redirect); reason a fixed code for skipped and failed items.
-- notice_dismissed_at: the editor's "blocks couldn't be kept" notice for the post was
-- dismissed.
CREATE TABLE "import_items" (
  "id"                  bigserial   PRIMARY KEY,
  "job_id"              bigint      NOT NULL REFERENCES "import_jobs" ("id") ON DELETE CASCADE,
  "position"            integer     NOT NULL,
  "source_key"          text        NOT NULL,
  "wp_id"               bigint      NOT NULL DEFAULT 0,
  "wp_type"             text        NOT NULL,
  "title"               text        NOT NULL DEFAULT '',
  "payload"             jsonb       NOT NULL DEFAULT '{}',
  "status"              text        NOT NULL DEFAULT 'pending'
    CONSTRAINT import_items_status CHECK ("status" IN ('pending', 'imported', 'skipped', 'failed')),
  "reason"              text        NOT NULL DEFAULT '',
  "post_id"             bigint      REFERENCES "posts" ("id") ON DELETE SET NULL,
  "result"              jsonb       NOT NULL DEFAULT '{}',
  "processed_at"        timestamptz,
  "notice_dismissed_at" timestamptz,
  CONSTRAINT import_items_job_key UNIQUE ("job_id", "source_key")
);

CREATE INDEX "import_items_job_status_idx" ON "import_items" ("job_id", "status", "position");
-- "Imported before": the same key imported by any job.
CREATE INDEX "import_items_imported_key_idx" ON "import_items" ("source_key") WHERE "status" = 'imported';
-- The editor's notice for an imported post.
CREATE INDEX "import_items_post_idx" ON "import_items" ("post_id") WHERE "post_id" IS NOT NULL;

-- The files of a Markdown zip that aren't Markdown (images the posts use), kept until the
-- job ends. Paths are the zip's, checked (no .., no absolute paths, no links).
CREATE TABLE "import_files" (
  "job_id" bigint NOT NULL REFERENCES "import_jobs" ("id") ON DELETE CASCADE,
  "path"   text   NOT NULL,
  "data"   bytea  NOT NULL,
  PRIMARY KEY ("job_id", "path")
);

-- Media an import added, by where it came from (the image's URL in the export, or
-- sha256:<hex> of a zip's file), so a resumed or repeated import reuses it instead of
-- downloading it again. Deleting the media drops the row: the next import fetches it anew.
CREATE TABLE "import_media" (
  "source_key" text        PRIMARY KEY,
  "media_id"   bigint      NOT NULL REFERENCES "media" ("id") ON DELETE CASCADE,
  "job_id"     bigint      REFERENCES "import_jobs" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "import_media_media_idx" ON "import_media" ("media_id");

-- Old WordPress URLs redirect to the imported posts (#331's table): a new source.
ALTER TABLE "redirects" DROP CONSTRAINT "redirects_source";
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_source"
  CHECK ("source" IN ('manual', 'post', 'term', 'merge', 'import'));
