-- Edit access requests and per-post grants (#321, 000039). Who may do what is
-- decided in api/auth_posts.go; these queries only read and write the rows.

-- name: IsPostCollaborator :one
SELECT EXISTS (
    SELECT 1 FROM post_collaborators
    WHERE post_id = @post_id AND user_id = @user_id
)::boolean AS is_collaborator;

-- name: ListPostCollaborators :many
-- The members granted edit access to a post, earliest grant first.
SELECT u.id, u.username, u.full_name, u.avatar_url,
       c.created_at AS granted_at,
       c.granted_by
FROM post_collaborators c
JOIN users u ON u.id = c.user_id
WHERE c.post_id = @post_id
ORDER BY c.created_at, u.id;

-- name: DeletePostCollaborator :execrows
DELETE FROM post_collaborators
WHERE post_id = @post_id AND user_id = @user_id;

-- name: CreatePostAccessRequest :one
-- A new open request. No row: the member's last request for this post was
-- declined less than cooldown_seconds ago. A second open request breaks the
-- post_access_requests_one_open index (a unique violation).
INSERT INTO post_access_requests (post_id, requester_id, message)
SELECT @post_id::bigint, @requester_id::bigint, @message::text
WHERE NOT EXISTS (
    SELECT 1 FROM post_access_requests r
    WHERE r.post_id = @post_id
      AND r.requester_id = @requester_id
      AND r.status = 'declined'
      AND r.reviewed_at > now() - make_interval(secs => @cooldown_seconds::float8)
)
RETURNING *;

-- name: GetPostAccessRequest :one
SELECT * FROM post_access_requests WHERE id = @id;

-- name: GetLatestPostAccessRequest :one
-- The member's newest request for the post (the view-only notice's state).
SELECT * FROM post_access_requests
WHERE post_id = @post_id AND requester_id = @requester_id
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: ListPendingPostAccessRequests :many
-- A post's open requests with who asked, oldest first (the editor's notice).
SELECT r.id, r.post_id, r.message, r.created_at,
       u.id AS requester_id, u.username AS requester_username,
       u.full_name AS requester_full_name, u.avatar_url AS requester_avatar_url
FROM post_access_requests r
JOIN users u ON u.id = r.requester_id
WHERE r.post_id = @post_id AND r.status = 'pending'
ORDER BY r.created_at, r.id;

-- name: ListPendingAccessRequestsForReviewer :many
-- Home's "Needs attention": the open requests a member may answer, newest
-- first. viewer_id 0 = every post (admins and editors), else the posts the
-- viewer owns (canReviewPostAccess). Posts in the trash are left out (nobody
-- may grant on them). total is the count before the limit.
SELECT r.id, r.post_id, r.message, r.created_at,
       p.title AS post_title, p.post_type,
       u.id AS requester_id, u.username AS requester_username, u.full_name AS requester_full_name,
       COUNT(*) OVER ()::bigint AS total
FROM post_access_requests r
JOIN posts p ON p.id = r.post_id
JOIN users u ON u.id = r.requester_id
WHERE r.status = 'pending'
  AND p.post_status <> 'trash'
  AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id::bigint)
ORDER BY r.created_at DESC, r.id DESC
LIMIT @row_limit::int;

-- name: ListAccessRequestReviewers :many
-- Who is emailed about a new request: every admin and editor, and the post's
-- owner if they are a contributor (canReviewPostAccess). The requester is left
-- out.
SELECT u.id, u.username, u.full_name, u.email
FROM users u
WHERE u.id <> @requester_id
  AND (u.role IN ('admin', 'editor')
       OR (u.role = 'contributor' AND u.id = (SELECT p.user_id FROM posts p WHERE p.id = @post_id)))
ORDER BY u.id;

-- name: ReviewPostAccessRequest :one
-- Answers an open request (claims it: a request already answered returns no
-- row). Run by ReviewPostAccessRequestTx under the request's row lock.
UPDATE post_access_requests
SET status = @status, reviewed_by = sqlc.narg(reviewed_by), reviewed_at = now()
WHERE id = @id AND status = 'pending'
RETURNING *;

-- name: GrantPostCollaborator :exec
-- Idempotent: a grant that already exists keeps its first date and granter.
INSERT INTO post_collaborators (post_id, user_id, granted_by)
VALUES (@post_id, @user_id, sqlc.narg(granted_by))
ON CONFLICT (post_id, user_id) DO NOTHING;
