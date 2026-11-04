-- Activity log (#324): one row per notable event, for Home's Activity feed, its
-- "Continue where you left off" and later readers (review requests #323, per-block
-- "last edited by" #328, access requests #321).
--
-- Append-only: rows are inserted (CreateActivity, CreateActivityThrottled) and
-- deleted by the retention prune (DeleteActivityBefore), never changed. The only
-- UPDATE allowed is the one the actor foreign key makes when a member is removed
-- (actor_id SET NULL), so the event stays with no author.
--
-- Privacy: the actor and the object are ids. payload is a small JSON object of
-- non-personal details (a role, a version number, setting names, a time); never
-- names, emails, IPs, user agents, titles or content. Readers join the current
-- names and titles at read time, under the reader's permissions.
CREATE TABLE "activity" (
  "id" bigserial PRIMARY KEY,
  -- Who did it; NULL for the system or a member removed since.
  "actor_id" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "verb" text NOT NULL CONSTRAINT "activity_verb_format" CHECK ("verb" ~ '^[a-z][a-z_]{0,39}$'),
  -- post | media | user | invitation | settings. No foreign key: the object may be
  -- deleted, and its events stay (moderators still see "deleted a post").
  "object_type" text NOT NULL CONSTRAINT "activity_object_type_format" CHECK ("object_type" ~ '^[a-z][a-z_]{0,39}$'),
  "object_id" bigint NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT "activity_payload_small_object" CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 1024),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- An object's history (the edit throttle's lookup, a post's events).
CREATE INDEX "idx_activity_object" ON "activity" ("object_type", "object_id", "created_at" DESC);
-- A member's own events ("Continue where you left off").
CREATE INDEX "idx_activity_actor" ON "activity" ("actor_id", "created_at" DESC) WHERE "actor_id" IS NOT NULL;
-- The retention prune.
CREATE INDEX "idx_activity_created_at" ON "activity" ("created_at");

CREATE FUNCTION golive_activity_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The users foreign key's ON DELETE SET NULL: only actor_id, only to NULL.
  IF NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.verb = OLD.verb AND NEW.object_type = OLD.object_type
     AND NEW.object_id = OLD.object_id AND NEW.payload = OLD.payload
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activity is append-only';
END;
$$;

CREATE TRIGGER "activity_append_only"
BEFORE UPDATE ON "activity"
FOR EACH ROW EXECUTE PROCEDURE golive_activity_append_only();
