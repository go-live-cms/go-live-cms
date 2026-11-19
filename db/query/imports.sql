-- The importer (#150, 000065). Jobs, their items, a Markdown zip's files and the media an
-- import added. Every write of a running job is fenced by its lease_token.

-- name: CreateImportJob :one
INSERT INTO import_jobs (created_by, source, file_name, site_url, summary, terms, attachments, blocks)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: CreateImportItem :exec
INSERT INTO import_items (job_id, position, source_key, wp_id, wp_type, title, payload, status, reason)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: CreateImportFile :exec
INSERT INTO import_files (job_id, path, data) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: GetImportFile :one
SELECT data FROM import_files WHERE job_id = $1 AND path = $2;

-- name: DeleteImportFiles :exec
DELETE FROM import_files WHERE job_id = $1;

-- name: GetImportJob :one
SELECT * FROM import_jobs WHERE id = $1;

-- name: ListImportJobs :many
-- The Import page's recent imports, newest first, without the parsed data.
SELECT id, created_by, source, file_name, site_url, status, summary, error, created_at, started_at, finished_at
FROM import_jobs
ORDER BY id DESC
LIMIT $1;

-- name: CountImportItemsByStatus :many
SELECT status, count(*)::bigint AS count,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(result->'dropped', '[]'::jsonb)) > 0)::bigint AS with_dropped
FROM import_items
WHERE job_id = $1
GROUP BY status;

-- name: CountImportedBefore :one
-- Items of this job whose key an earlier job imported, its post still there: the mapping
-- step's "imported before, will be skipped".
SELECT count(*)::bigint FROM import_items i
WHERE i.job_id = $1
  AND EXISTS (
    SELECT 1 FROM import_items o
    WHERE o.source_key = i.source_key AND o.status = 'imported' AND o.post_id IS NOT NULL AND o.job_id <> i.job_id
  );

-- name: ListImportItems :many
-- The report's rows (no payload). status '' = every status; dropped_only = imported posts
-- with dropped blocks.
SELECT i.id, i.position, i.wp_type, i.title, i.status, i.reason, i.post_id, i.result, i.processed_at,
       p.post_type AS post_type, p.post_status AS post_status
FROM import_items i
LEFT JOIN posts p ON p.id = i.post_id
WHERE i.job_id = @job_id
  AND (@status::text = '' OR i.status = @status::text)
  AND (NOT @dropped_only::boolean OR jsonb_array_length(COALESCE(i.result->'dropped', '[]'::jsonb)) > 0)
ORDER BY i.position
LIMIT @lim OFFSET @off;

-- name: SetImportJobMapping :one
-- Start: the mapping is saved and the job queued, only from 'mapping'.
UPDATE import_jobs SET mapping = $2, status = 'queued'
WHERE id = $1 AND status = 'mapping'
RETURNING *;

-- name: CancelImportJob :one
-- Stop: what's imported stays; the worker's next fenced write fails and it moves on.
UPDATE import_jobs
SET status = 'cancelled', lease_until = NULL, finished_at = now()
WHERE id = $1 AND status IN ('mapping', 'queued', 'running')
RETURNING *;

-- name: DeleteImportJob :execrows
-- Only a job that isn't queued or running; its items, files and report go with it (the
-- posts and media stay).
DELETE FROM import_jobs WHERE id = $1 AND status NOT IN ('queued', 'running');

-- name: ClaimImportJob :one
-- One runnable job (queued, or running with its lease run out), oldest first, SKIP LOCKED so
-- replicas take different ones. The new token fences every write of this claim.
UPDATE import_jobs j
SET status = 'running',
    lease_until = now() + interval '2 minutes',
    lease_token = j.lease_token + 1,
    started_at = COALESCE(j.started_at, now())
WHERE j.id = (
  SELECT c.id FROM import_jobs c
  WHERE c.status IN ('queued', 'running') AND (c.lease_until IS NULL OR c.lease_until < now())
  ORDER BY c.id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: RenewImportJobLease :execrows
UPDATE import_jobs SET lease_until = now() + interval '2 minutes'
WHERE id = $1 AND lease_token = $2 AND status = 'running';

-- name: SetImportJobTermIDs :execrows
UPDATE import_jobs SET term_ids = $3
WHERE id = $1 AND lease_token = $2 AND status = 'running';

-- name: FinishImportJob :execrows
UPDATE import_jobs
SET status = @status::text, error = @error::text, lease_until = NULL, finished_at = now()
WHERE id = @id AND lease_token = @lease_token AND status = 'running';

-- name: NextPendingImportItem :one
SELECT * FROM import_items
WHERE job_id = $1 AND status = 'pending'
ORDER BY position
LIMIT 1;

-- name: FinishImportItem :execrows
-- A skipped or failed item (an imported one is ImportPostTx's), fenced by the job's claim.
UPDATE import_items i
SET status = @status::text, reason = @reason::text, result = @result, post_id = sqlc.narg(post_id), processed_at = now()
WHERE i.id = @id AND i.status = 'pending'
  AND EXISTS (SELECT 1 FROM import_jobs j WHERE j.id = i.job_id AND j.lease_token = @lease_token AND j.status = 'running');

-- name: GetImportedPostBySourceKey :one
-- The post an earlier import made from this key, if it still exists.
SELECT i.post_id::bigint AS post_id, i.job_id
FROM import_items i
WHERE i.source_key = $1 AND i.status = 'imported' AND i.post_id IS NOT NULL
ORDER BY i.id
LIMIT 1;

-- name: GetImportedPostByWpID :one
-- A page's parent: the post this job (or an earlier one, by key) made from WordPress id.
SELECT i.post_id::bigint AS post_id
FROM import_items i
WHERE i.job_id = $1 AND i.wp_id = $2 AND i.post_id IS NOT NULL
LIMIT 1;

-- name: LockImportSourceKey :exec
-- Two jobs importing the same key at once: one at a time, so the second sees the first's.
SELECT pg_advisory_xact_lock(hashtext('golive_import:' || @source_key::text));

-- name: SetImportedPostDates :exec
-- The export's dates, before the post is published: first_published_at can only be set
-- while it is NULL (000061's trigger keeps the first value), so a published import keeps
-- its original date for "close comments after N days" too.
UPDATE posts
SET created_at = @created_at, changed_at = @changed_at, first_published_at = sqlc.narg(first_published_at)
WHERE id = @id;

-- name: GetImportMedia :one
SELECT m.* FROM import_media im JOIN media m ON m.id = im.media_id
WHERE im.source_key = $1;

-- name: CreateImportMedia :exec
INSERT INTO import_media (source_key, media_id, job_id) VALUES ($1, $2, $3)
ON CONFLICT (source_key) DO NOTHING;

-- name: GetImportNoticeForPost :one
-- The editor's "blocks couldn't be kept" notice: the latest import of the post with dropped
-- blocks, not dismissed.
SELECT id, result FROM import_items
WHERE post_id = $1 AND status = 'imported' AND notice_dismissed_at IS NULL
  AND jsonb_array_length(COALESCE(result->'dropped', '[]'::jsonb)) > 0
ORDER BY id DESC
LIMIT 1;

-- name: DismissImportNotice :execrows
UPDATE import_items SET notice_dismissed_at = now()
WHERE id = $1 AND post_id = $2 AND notice_dismissed_at IS NULL;
