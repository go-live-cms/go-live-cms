-- Redirects (#331, 000047). One row per old site path; see redirects_tx.go for how
-- chains are kept collapsed and loops refused.

-- name: LockRedirects :exec
-- Serializes redirect writes (rare), so two can't build a chain or loop between them.
SELECT pg_advisory_xact_lock(331047);

-- name: GetRedirectByFromPath :one
SELECT * FROM redirects WHERE from_path = $1;

-- name: GetRedirect :one
SELECT * FROM redirects WHERE id = $1;

-- name: DeleteRedirectFromPath :execrows
DELETE FROM redirects WHERE from_path = $1;

-- name: RetargetRedirects :execrows
-- Chain collapse: what pointed at old_to now points at new_to (A→B, then B→C: A→C).
UPDATE redirects SET to_path = @new_to::text WHERE to_path = @old_to::text;

-- name: UpsertRedirect :one
-- An automatic redirect replaces an older one from the same path.
INSERT INTO redirects (from_path, to_path, status_code, source, created_by)
VALUES (@from_path, @to_path, @status_code, @source, sqlc.narg(created_by))
ON CONFLICT (from_path) DO UPDATE
SET to_path = EXCLUDED.to_path,
    status_code = EXCLUDED.status_code,
    source = EXCLUDED.source,
    created_by = EXCLUDED.created_by,
    created_at = now()
RETURNING *;

-- name: InsertRedirect :one
-- A manual redirect: a path that already redirects is a conflict (unique violation).
INSERT INTO redirects (from_path, to_path, status_code, source, created_by)
VALUES (@from_path, @to_path, @status_code, @source, sqlc.narg(created_by))
RETURNING *;

-- name: ListRedirects :many
-- Settings › URLs & redirects, newest first, with who made each (public fields).
SELECT
    r.id, r.from_path, r.to_path, r.status_code, r.source, r.created_by, r.created_at,
    u.username AS created_by_username,
    u.full_name AS created_by_full_name,
    u.avatar_url AS created_by_avatar
FROM redirects r
LEFT JOIN users u ON u.id = r.created_by
WHERE (@query::text = '' OR r.from_path ILIKE @query::text OR r.to_path ILIKE @query::text)
ORDER BY r.created_at DESC, r.id DESC
LIMIT @row_limit::int OFFSET @row_offset::int;

-- name: CountRedirects :one
SELECT COUNT(*)::bigint FROM redirects r
WHERE (@query::text = '' OR r.from_path ILIKE @query::text OR r.to_path ILIKE @query::text);

-- name: DeleteRedirect :one
DELETE FROM redirects WHERE id = $1 RETURNING *;
