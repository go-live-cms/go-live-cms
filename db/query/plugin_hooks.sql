-- Server hooks (#458, 000055, docs/design/plugin-system.md 7.4 to 7.6). The posts
-- trigger writes plugin_events; RunPluginHooks (api/plugin_hooks.go) fans each event
-- out to one plugin_hook_runs row per subscribed plugin, claims due runs, runs the
-- hooks outside any transaction and records the result here.

-- name: ListHookPlugins :many
-- The plugins whose hooks may run: enabled, in this build, and declaring a hook.
SELECT id, slug, manifest FROM plugins
WHERE enabled
  AND status = 'installed'
  AND jsonb_typeof(manifest -> 'server' -> 'hooks') = 'array'
  AND jsonb_array_length(manifest -> 'server' -> 'hooks') > 0
ORDER BY slug;

-- name: FanOutPluginEvents :one
-- Writes the runs of the oldest events not fanned out yet: one per plugin enabled and
-- subscribed now. A post.saved gets no run for a plugin that already has a pending
-- post.saved run for that post: the hook reads the post when it runs, so one is enough
-- and a slow plugin can't build a backlog of saves. An event that gets no run at all
-- is deleted.
--
-- One replica at a time (a transaction-level advisory lock; the others skip the
-- round), so events are fanned out in id order and a later event's run never exists
-- before an earlier one's for the same post. locked = false: another replica holds it.
WITH lock AS (
    SELECT pg_try_advisory_xact_lock(458001) AS got
), batch AS (
    SELECT e.id, e.event, e.post_id FROM plugin_events e
    WHERE NOT e.fanned_out
      AND (SELECT got FROM lock)
    ORDER BY e.id
    LIMIT @max_events::int
    FOR UPDATE
), subscriptions AS (
    SELECT p.id AS plugin_id, hook ->> 'event' AS event
    FROM plugins p
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.manifest -> 'server' -> 'hooks') = 'array'
             THEN p.manifest -> 'server' -> 'hooks' ELSE '[]'::jsonb END) AS hook
    WHERE p.enabled AND p.status = 'installed'
), runs AS (
    INSERT INTO plugin_hook_runs (event_id, plugin_id, post_id, event)
    SELECT b.id, s.plugin_id, b.post_id, b.event
    FROM batch b
    JOIN subscriptions s ON s.event = b.event
    WHERE NOT (b.event = 'post.saved' AND EXISTS (
        SELECT 1 FROM plugin_hook_runs r
        WHERE r.plugin_id = s.plugin_id
          AND r.post_id = b.post_id
          AND r.event = 'post.saved'
          AND r.status = 'pending'))
    ORDER BY b.id, s.plugin_id
    ON CONFLICT DO NOTHING
    RETURNING event_id
), marked AS (
    UPDATE plugin_events e SET fanned_out = true
    FROM batch b
    WHERE e.id = b.id AND b.id IN (SELECT event_id FROM runs)
    RETURNING e.id
), dropped AS (
    DELETE FROM plugin_events e
    USING batch b
    WHERE e.id = b.id AND b.id NOT IN (SELECT event_id FROM runs)
    RETURNING e.id
)
SELECT (SELECT got FROM lock)::bool AS locked,
       (SELECT count(*) FROM runs)::bigint AS runs,
       (SELECT count(*) FROM marked)::bigint AS fanned_out,
       (SELECT count(*) FROM dropped)::bigint AS dropped;

-- name: SkipInactivePluginHookRuns :execrows
-- Runs of a plugin that was disabled, removed from the build or became incompatible
-- since its events were fanned out: skipped, not run. A run in flight (a live lease)
-- is left to finish.
UPDATE plugin_hook_runs r
SET status = 'skipped',
    finished_at = now()
FROM plugins p
WHERE p.id = r.plugin_id
  AND NOT (p.enabled AND p.status = 'installed')
  AND (r.status = 'pending' OR (r.status = 'running' AND r.next_attempt_at <= now()));

-- name: ClaimDuePluginHookRuns :many
-- Takes up to max_runs due runs of one plugin, for the events this process has a hook
-- for, and leases them: status running, next_attempt_at lease_seconds ahead (the
-- fencing token the record queries check). A running run whose lease has passed (its
-- process died) is due again. A run is not due while an earlier run of the same plugin
-- for the same post is unfinished, so each plugin sees a post's events in order (7.5).
-- FOR UPDATE SKIP LOCKED keeps replicas apart; the lock ends with the statement, never
-- held across a hook.
WITH due AS (
    SELECT r.event_id, r.plugin_id FROM plugin_hook_runs r
    JOIN plugins p ON p.id = r.plugin_id
    WHERE r.plugin_id = @plugin_id
      AND p.enabled AND p.status = 'installed'
      AND r.event = ANY(@events::text[])
      AND r.status IN ('pending', 'running')
      AND r.next_attempt_at <= now()
      AND NOT EXISTS (
          SELECT 1 FROM plugin_hook_runs earlier
          WHERE earlier.plugin_id = r.plugin_id
            AND earlier.post_id = r.post_id
            AND earlier.event_id < r.event_id
            AND earlier.status IN ('pending', 'running'))
    ORDER BY r.event_id
    LIMIT @max_runs::int
    FOR UPDATE OF r SKIP LOCKED
)
UPDATE plugin_hook_runs r
SET status = 'running',
    attempts = r.attempts + 1,
    next_attempt_at = now() + make_interval(secs => @lease_seconds::float8)
FROM due, plugin_events e
WHERE r.event_id = due.event_id
  AND r.plugin_id = due.plugin_id
  AND e.id = r.event_id
RETURNING r.event_id, r.plugin_id, r.attempts, r.next_attempt_at AS claim,
          e.event, e.post_id, e.actor_id, e.data, e.created_at;

-- name: RecordPluginHookRunDone :execrows
-- The hook returned nil. 0 rows: the claim was lost (its lease ran out and another
-- replica took the run), so this result isn't recorded.
UPDATE plugin_hook_runs
SET status = 'done',
    last_error = NULL,
    finished_at = now()
WHERE event_id = @event_id
  AND plugin_id = @plugin_id
  AND status = 'running'
  AND next_attempt_at = @claim;

-- name: RecordPluginHookRunFailure :one
-- The hook failed, panicked or timed out: pending again after retry_after_seconds, or
-- failed for good once it has had max_attempts. No row: the claim was lost.
UPDATE plugin_hook_runs
SET status = CASE WHEN attempts >= @max_attempts::int THEN 'failed' ELSE 'pending' END,
    next_attempt_at = CASE WHEN attempts >= @max_attempts::int THEN next_attempt_at
                           ELSE now() + make_interval(secs => @retry_after_seconds::float8) END,
    finished_at = CASE WHEN attempts >= @max_attempts::int THEN now() END,
    last_error = @last_error::text
WHERE event_id = @event_id
  AND plugin_id = @plugin_id
  AND status = 'running'
  AND next_attempt_at = @claim
RETURNING status, attempts;

-- name: CreatePluginHookFailedActivity :execrows
-- plugin_hook_failed (#324), as the system: at most one per plugin per window, so a
-- plugin failing on every save can't flood the log. 0 rows: one is in the window.
INSERT INTO activity (actor_id, verb, object_type, object_id, payload)
SELECT NULL, 'plugin_hook_failed', 'plugin', @plugin_id::bigint, @payload::jsonb
WHERE NOT EXISTS (
    SELECT 1 FROM activity a
    WHERE a.object_type = 'plugin'
      AND a.object_id = @plugin_id::bigint
      AND a.verb = 'plugin_hook_failed'
      AND a.created_at > now() - make_interval(secs => @window_seconds::float8)
);

-- name: DeleteFinishedPluginHookRuns :execrows
-- Retention: up to batch_size runs with this status that finished before cutoff.
DELETE FROM plugin_hook_runs
WHERE (event_id, plugin_id) IN (
    SELECT r.event_id, r.plugin_id FROM plugin_hook_runs r
    WHERE r.status = @status
      AND r.finished_at < @cutoff::timestamptz
    LIMIT @batch_size::int
);

-- name: DeleteSpentPluginEvents :execrows
-- Retention: up to batch_size fanned-out events with no runs left.
DELETE FROM plugin_events
WHERE id IN (
    SELECT e.id FROM plugin_events e
    WHERE e.fanned_out
      AND NOT EXISTS (SELECT 1 FROM plugin_hook_runs r WHERE r.event_id = e.id)
    LIMIT @batch_size::int
);

-- name: ListPluginExtensionSettings :many
-- A plugin's stored settings (extension_settings, extension_type 'plugin'), for
-- pluginsdk.Host.Settings.
SELECT key, value FROM extension_settings
WHERE extension_type = 'plugin' AND extension_id = @slug
ORDER BY key;
