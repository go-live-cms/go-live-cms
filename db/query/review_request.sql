-- Review requests (#323, 000039). Publishing resolves the open one in a trigger
-- (golive_resolve_review_on_publish); the API writes the rest here.

-- name: CreateReviewRequest :one
-- A new open request. Nothing is inserted (sql.ErrNoRows) when the post already
-- has one: review_requests_one_open decides, so two requests racing can't both win.
INSERT INTO review_requests (post_id, requested_by, reviewer_id, message)
VALUES (sqlc.arg(post_id), sqlc.arg(requested_by), sqlc.narg(reviewer_id), sqlc.arg(message))
ON CONFLICT (post_id) WHERE status = 'open' DO NOTHING
RETURNING *;

-- name: GetReviewRequest :one
SELECT * FROM review_requests WHERE id = $1;

-- name: ResolveReviewRequest :one
-- Dismiss or request changes (the API checks who may). Only an open request:
-- sql.ErrNoRows when it was resolved meanwhile (published, dismissed, ...).
UPDATE review_requests
SET status = sqlc.arg(status),
    resolved_by = sqlc.narg(resolved_by),
    resolution_note = sqlc.arg(resolution_note),
    resolved_at = now()
WHERE id = sqlc.arg(id) AND status = 'open'
RETURNING *;

-- name: GetCurrentReviewRequest :one
-- The editor's review notice: the post's latest request when it is open, or when a
-- reviewer asked for changes and nothing was published since (the note still
-- applies). Names are joined now; NULL for a member removed since.
SELECT rr.id, rr.post_id, rr.status, rr.message, rr.resolution_note, rr.created_at, rr.resolved_at,
    rr.requested_by, rq.username AS requester_username, rq.full_name AS requester_full_name, rq.avatar_url AS requester_avatar_url,
    rr.reviewer_id, rv.username AS reviewer_username, rv.full_name AS reviewer_full_name, rv.avatar_url AS reviewer_avatar_url,
    rr.resolved_by, rs.username AS resolver_username, rs.full_name AS resolver_full_name, rs.avatar_url AS resolver_avatar_url
FROM review_requests rr
LEFT JOIN users rq ON rq.id = rr.requested_by
LEFT JOIN users rv ON rv.id = rr.reviewer_id
LEFT JOIN users rs ON rs.id = rr.resolved_by
WHERE rr.id = (SELECT max(l.id) FROM review_requests l WHERE l.post_id = sqlc.arg(post_id))
    AND (rr.status = 'open'
         OR (rr.status = 'changes_requested'
             AND NOT EXISTS (SELECT 1 FROM post_versions v WHERE v.post_id = rr.post_id AND v.created_at > rr.resolved_at)));

-- name: GetReviewRequestDetail :one
-- One request with GetCurrentReviewRequest's columns (the response after a write).
SELECT rr.id, rr.post_id, rr.status, rr.message, rr.resolution_note, rr.created_at, rr.resolved_at,
    rr.requested_by, rq.username AS requester_username, rq.full_name AS requester_full_name, rq.avatar_url AS requester_avatar_url,
    rr.reviewer_id, rv.username AS reviewer_username, rv.full_name AS reviewer_full_name, rv.avatar_url AS reviewer_avatar_url,
    rr.resolved_by, rs.username AS resolver_username, rs.full_name AS resolver_full_name, rs.avatar_url AS resolver_avatar_url
FROM review_requests rr
LEFT JOIN users rq ON rq.id = rr.requested_by
LEFT JOIN users rv ON rv.id = rr.reviewer_id
LEFT JOIN users rs ON rs.id = rr.resolved_by
WHERE rr.id = $1;

-- name: ListOpenReviewRequestsForPosts :many
-- The posts list's "Review requested" indicator, for one page of rows.
SELECT rr.id, rr.post_id, rr.created_at,
    rr.requested_by, rq.username AS requester_username, rq.full_name AS requester_full_name,
    rr.reviewer_id, rv.username AS reviewer_username, rv.full_name AS reviewer_full_name
FROM review_requests rr
LEFT JOIN users rq ON rq.id = rr.requested_by
LEFT JOIN users rv ON rv.id = rr.reviewer_id
WHERE rr.status = 'open' AND rr.post_id = ANY(sqlc.arg(post_ids)::bigint[]);

-- name: ListReviewRequestsForReviewer :many
-- Home's Needs attention for an editor or admin (@viewer_id): open requests naming
-- them, or naming nobody, or naming someone who can no longer review (not one of
-- @reviewer_roles, auth_roles.go), never their own requests, never a post in the
-- trash. Theirs first, then the longest waiting. total = how many in all.
SELECT rr.id, rr.post_id, rr.created_at, rr.message, p.title, p.post_type,
    rr.requested_by, rq.username AS requester_username, rq.full_name AS requester_full_name,
    (rr.reviewer_id IS NOT NULL AND rr.reviewer_id = sqlc.arg(viewer_id)::bigint)::boolean AS assigned_to_viewer,
    COUNT(*) OVER () AS total
FROM review_requests rr
JOIN posts p ON p.id = rr.post_id
LEFT JOIN users rq ON rq.id = rr.requested_by
LEFT JOIN users rv ON rv.id = rr.reviewer_id
WHERE rr.status = 'open'
    AND p.post_status <> 'trash'
    AND rr.requested_by IS DISTINCT FROM sqlc.arg(viewer_id)::bigint
    AND (rr.reviewer_id = sqlc.arg(viewer_id)::bigint
         OR rv.id IS NULL
         OR NOT (lower(rv.role) = ANY(sqlc.arg(reviewer_roles)::text[])))
ORDER BY (rr.reviewer_id IS NOT NULL AND rr.reviewer_id = sqlc.arg(viewer_id)::bigint) DESC, rr.created_at, rr.id
LIMIT sqlc.arg(row_limit)::int;

-- name: ListReviewers :many
-- Who can review (#323): members with one of @roles (editors and admins, from
-- auth_roles.go), for the Request review picker. Public fields only.
SELECT id, username, full_name, avatar_url
FROM users
WHERE lower(role) = ANY(sqlc.arg(roles)::text[])
ORDER BY lower(full_name), username, id
LIMIT sqlc.arg(limit_count)::int;

-- name: ListReviewRecipients :many
-- Who a new request emails: the named reviewer (@reviewer_id), or with none every
-- editor and admin (@roles); never the requester (@requester_id). Each gets their own
-- email, so recipients never see each other's addresses. Past @limit_count, the most
-- recently active (then the newest accounts) are the ones emailed.
SELECT id, email, username, full_name
FROM users
WHERE lower(role) = ANY(sqlc.arg(roles)::text[])
    AND id <> sqlc.arg(requester_id)::bigint
    AND (sqlc.arg(reviewer_id)::bigint = 0 OR id = sqlc.arg(reviewer_id)::bigint)
ORDER BY last_active_at DESC NULLS LAST, id DESC
LIMIT sqlc.arg(limit_count)::int;
