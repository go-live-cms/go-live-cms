-- Server hooks (#458, docs/design/plugin-system.md sections 7.2 to 7.6): the event
-- trigger on posts and the outbox the hook dispatcher (api/plugin_hooks.go,
-- RunPluginHooks) drains.
--
-- Events are written by the database, not by Go: publishing alone has six paths (the
-- Publish button, bulk, the scheduler, scheduled updates, post_status through PUT or
-- POST /posts), and 000044's review trigger showed that only a trigger covers every
-- one of them and the next. The event commits with the change that caused it, so a
-- publish that rolled back has no event and a committed one can't lose its event in a
-- crash. Plugin code never runs here: the dispatcher runs hooks after the commit,
-- outside any transaction (7.3).

-- One row per event, until every plugin that subscribed to it has run (or the runs are
-- pruned). post_id has no FK: post.deleted outlives its post. data holds ids and small
-- facts only, as activity.payload does (000036's privacy rule).
CREATE TABLE "plugin_events" (
  "id"         bigserial PRIMARY KEY,
  "event"      varchar NOT NULL,
  "post_id"    bigint  NOT NULL,
  "actor_id"   bigint,
  "data"       jsonb   NOT NULL DEFAULT '{}'::jsonb
               CONSTRAINT "plugin_events_data_object" CHECK (jsonb_typeof("data") = 'object'),
  -- Set once the dispatcher has written this event's plugin_hook_runs.
  "fanned_out" boolean NOT NULL DEFAULT false,
  -- The writing transaction. Only plugin_events_one_publish reads it.
  "txid"       bigint  NOT NULL DEFAULT txid_current(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- At most one post.saved per post waiting for fan-out. The collab store can save a
-- post every 2 to 10 seconds per open document, and a hook reads the post as it is
-- when it runs, so one pending save stands for all of them (the trigger's insert is
-- ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "plugin_events_one_pending_save" ON "plugin_events" ("post_id")
  WHERE "event" = 'post.saved' AND NOT "fanned_out";

-- At most one post.published per post and transaction. Every publish path changes the
-- row once today; this keeps a future path that writes it twice (a status, then a
-- version) from announcing one publish twice.
CREATE UNIQUE INDEX "plugin_events_one_publish" ON "plugin_events" ("post_id", "txid")
  WHERE "event" = 'post.published';

-- The fan-out's scan.
CREATE INDEX "idx_plugin_events_pending" ON "plugin_events" ("id") WHERE NOT "fanned_out";

-- One row per (event, plugin) to run. next_attempt_at is when a pending run is due and,
-- while it runs, its lease (the claim's fencing token, as posts.publish_next_attempt_at
-- is the scheduler's). post_id copies the event's, for the ordering check (7.5).
CREATE TABLE "plugin_hook_runs" (
  "event_id"        bigint NOT NULL REFERENCES "plugin_events" ("id") ON DELETE CASCADE,
  "plugin_id"       bigint NOT NULL REFERENCES "plugins" ("id") ON DELETE CASCADE,
  "post_id"         bigint NOT NULL,
  "event"           varchar NOT NULL,
  "status"          varchar NOT NULL DEFAULT 'pending'
                    CONSTRAINT "plugin_hook_runs_status"
                    CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'skipped')),
  "attempts"        int NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  -- Capped by the dispatcher; an error message, never a payload.
  "last_error"      text
                    CONSTRAINT "plugin_hook_runs_last_error_length" CHECK (char_length("last_error") <= 1000),
  "finished_at"     timestamptz,
  PRIMARY KEY ("event_id", "plugin_id"),
  CONSTRAINT "plugin_hook_runs_finished" CHECK (("status" IN ('done', 'failed', 'skipped')) = ("finished_at" IS NOT NULL))
);

-- The claim: unfinished runs by plugin, and the ordering check (an earlier unfinished
-- run for the same plugin and post holds a later one).
CREATE INDEX "idx_plugin_hook_runs_unfinished" ON "plugin_hook_runs" ("plugin_id", "post_id", "event_id")
  WHERE "status" IN ('pending', 'running');
-- Retention: finished runs by age.
CREATE INDEX "idx_plugin_hook_runs_finished" ON "plugin_hook_runs" ("finished_at")
  WHERE "finished_at" IS NOT NULL;

-- Whether an enabled plugin in this build subscribes to the event: its manifest
-- declares the hook. A missing or incompatible plugin keeps `enabled` but doesn't run.
CREATE FUNCTION golive_plugin_event_subscribed(event_name text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM plugins p
    WHERE p.enabled
      AND p.status = 'installed'
      AND p.manifest -> 'server' -> 'hooks' @> jsonb_build_array(jsonb_build_object('event', event_name))
  );
$$;

-- The events of one change to a post (7.2):
--
--   post.saved        INSERT, or changed_at moved: every collab store that wrote
--                     block_doc, POST /posts, duplicate, from template, REST settings
--                     saves. Settings saves and body stores are one event (section 11's
--                     open question kept the default).
--   post.published    post_status becomes published (not from the trash), a new
--                     published_version_id, or an INSERT as published. 000044's
--                     condition plus the insert. The actor is the new version's
--                     created_by; NULL for a status set through PUT or POST.
--   post.unpublished  post_status leaves published, other than to the trash.
--   post.trashed      post_status becomes trash.
--   post.restored     post_status leaves trash. Not also post.published: a restore
--                     puts the old live version back.
--   post.deleted      DELETE of the row (the permanent delete). Carries post_type,
--                     since the row is gone when the hook runs.
--
-- One INSERT ... SELECT whose WHERE drops every event nobody subscribes to, so a site
-- with no subscriber writes no row, and nothing here can fail a write to posts but the
-- insert itself. Unsubscribed changes cost one function call and, when an event
-- applies, one read of the small plugins table.
CREATE FUNCTION golive_post_plugin_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  events text[] := '{}';
  row_id bigint;
  row_type text;
  row_status text;
  publisher bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_id := OLD.id;
    row_type := OLD.post_type;
    row_status := OLD.post_status;
    events := ARRAY['post.deleted'];
  ELSE
    row_id := NEW.id;
    row_type := NEW.post_type;
    row_status := NEW.post_status;
    IF TG_OP = 'INSERT' THEN
      events := ARRAY['post.saved'];
      IF NEW.post_status = 'published' THEN
        events := events || 'post.published'::text;
      END IF;
    ELSE
      IF NEW.changed_at IS DISTINCT FROM OLD.changed_at THEN
        events := events || 'post.saved'::text;
      END IF;
      IF NEW.post_status = 'published'
         AND ((OLD.post_status IS DISTINCT FROM NEW.post_status AND OLD.post_status <> 'trash')
              OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id) THEN
        events := events || 'post.published'::text;
      END IF;
      IF OLD.post_status = 'published' AND NEW.post_status NOT IN ('published', 'trash') THEN
        events := events || 'post.unpublished'::text;
      END IF;
      IF NEW.post_status = 'trash' AND OLD.post_status IS DISTINCT FROM 'trash' THEN
        events := events || 'post.trashed'::text;
      END IF;
      IF OLD.post_status = 'trash' AND NEW.post_status IS DISTINCT FROM 'trash' THEN
        events := events || 'post.restored'::text;
      END IF;
    END IF;
  END IF;

  IF cardinality(events) = 0 THEN
    RETURN NULL;
  END IF;

  IF 'post.published' = ANY(events) AND NEW.published_version_id IS NOT NULL THEN
    SELECT v.created_by INTO publisher FROM post_versions v WHERE v.id = NEW.published_version_id;
  END IF;

  INSERT INTO plugin_events (event, post_id, actor_id, data)
  SELECT e.name,
         row_id,
         CASE WHEN e.name = 'post.published' THEN publisher END,
         jsonb_strip_nulls(jsonb_build_object(
           'post_type', row_type,
           'post_status', row_status,
           'from_status', CASE WHEN TG_OP = 'UPDATE' AND e.name <> 'post.saved' THEN OLD.post_status END,
           'version_id', CASE WHEN e.name = 'post.published' THEN NEW.published_version_id END
         ))
  FROM unnest(events) WITH ORDINALITY AS e(name, ord)
  WHERE golive_plugin_event_subscribed(e.name)
  ORDER BY e.ord
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "posts_plugin_events"
AFTER INSERT OR UPDATE OR DELETE ON "posts"
FOR EACH ROW
EXECUTE PROCEDURE golive_post_plugin_events();
