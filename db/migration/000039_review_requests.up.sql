-- Review requests (#323): anyone who can edit a post asks an editor or admin to
-- review it, optionally naming one. A request is open until the post is published
-- (any path: Publish, Update, the scheduler, bulk publish), it is dismissed (by a
-- reviewer, or withdrawn by its requester), or a reviewer requests changes with a
-- note.
--
-- One open request per post (review_requests_one_open): a second request while one
-- is open is refused (the API answers 409 with the open one), so reviewers aren't
-- emailed twice for the same post; to name another reviewer, withdraw and ask again.
--
-- Resolved rows stay (the post's review history). requested_by / reviewer_id /
-- resolved_by are SET NULL when a member is removed: a request without a reviewer is
-- open to every editor and admin. The post's deletion takes its requests with it.
CREATE TABLE "review_requests" (
  "id" bigserial PRIMARY KEY,
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "requested_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  -- The editor or admin asked; NULL = any of them.
  "reviewer_id" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  -- The requester's optional note, plain text.
  "message" text NOT NULL DEFAULT ''
    CONSTRAINT "review_requests_message_length" CHECK (char_length("message") <= 1000),
  "status" text NOT NULL DEFAULT 'open'
    CONSTRAINT "review_requests_status" CHECK ("status" IN ('open', 'published', 'dismissed', 'changes_requested')),
  "resolved_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  -- The reviewer's note with "changes requested" (required then), plain text.
  "resolution_note" text NOT NULL DEFAULT ''
    CONSTRAINT "review_requests_note_length" CHECK (char_length("resolution_note") <= 2000),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz NULL,
  CONSTRAINT "review_requests_resolved_at" CHECK (("status" = 'open') = ("resolved_at" IS NULL)),
  CONSTRAINT "review_requests_changes_note" CHECK ("status" <> 'changes_requested' OR "resolution_note" ~ '\S')
);

-- At most one open request per post; also the lookup of a post's open request.
CREATE UNIQUE INDEX "review_requests_one_open" ON "review_requests" ("post_id") WHERE "status" = 'open';
-- A post's latest request (the editor's notice), and the cascade.
CREATE INDEX "idx_review_requests_post" ON "review_requests" ("post_id", "id" DESC);
-- Home's Needs attention: open requests.
CREATE INDEX "idx_review_requests_open" ON "review_requests" ("created_at") WHERE "status" = 'open';

-- Publishing resolves the open request, whichever path publishes: the Publish and
-- Update buttons and bulk publish (PublishPostTx), the scheduler (#147's
-- PublishScheduledPostTx, #335's PublishScheduledUpdateTx) and a status set through
-- PUT /posts/:id. A trigger rather than each writer, so a new publish path can't
-- forget it. The resolver is whoever the new version is credited to (who published,
-- or who scheduled it); NULL when only the status changed (no new version).
--
-- The activity event (#324, "review_resolved") is written here too, in the publish's
-- transaction: it can't describe a publish that rolled back, and no writer has to
-- know a request was open. Ids only, as every event (000036's privacy rule).
CREATE FUNCTION golive_resolve_review_on_publish() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  publisher bigint;
  resolved_id bigint;
BEGIN
  IF NEW.published_version_id IS DISTINCT FROM OLD.published_version_id AND NEW.published_version_id IS NOT NULL THEN
    SELECT v.created_by INTO publisher FROM post_versions v WHERE v.id = NEW.published_version_id;
  END IF;

  UPDATE review_requests
  SET status = 'published', resolved_by = publisher, resolved_at = now()
  WHERE post_id = NEW.id AND status = 'open'
  RETURNING id INTO resolved_id;

  IF resolved_id IS NOT NULL THEN
    INSERT INTO activity (actor_id, verb, object_type, object_id, payload)
    VALUES (publisher, 'review_resolved', 'post', NEW.id,
            jsonb_build_object('request_id', resolved_id, 'resolution', 'published'));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "posts_resolve_review_on_publish"
AFTER UPDATE OF "post_status", "published_version_id" ON "posts"
FOR EACH ROW
-- Restoring a published post from the trash (#327) isn't a publish: it puts the old
-- live version back, not the changes under review, so the request stays open.
WHEN (NEW.post_status = 'published'
      AND ((OLD.post_status IS DISTINCT FROM NEW.post_status AND OLD.post_status <> 'trash')
           OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id))
EXECUTE PROCEDURE golive_resolve_review_on_publish();
