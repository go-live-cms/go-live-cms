-- name: CreateUser :one
INSERT INTO users (
    username,
    full_name,
    email,
    hashed_password,
    role
) VALUES (
    $1, $2, $3, $4, $5
) RETURNING *;

-- name: GetUser :one
SELECT * FROM users
WHERE id = $1 LIMIT 1;

-- name: GetUserByUsername :one
SELECT * FROM users
WHERE username = $1
LIMIT 1;

-- name: GetUserByEmail :one
SELECT * FROM users
WHERE email = $1
LIMIT 1;

-- name: GetUserByEmailFold :one
-- Ignoring case: emails are stored lowercased by the API, but an account created
-- with SQL (the first admin, deploy.md) may hold capitals. Open signup (#191) must
-- still treat that address as taken.
SELECT * FROM users
WHERE lower(email) = lower(sqlc.arg(email)::text)
LIMIT 1;

-- name: ListUsers :many
SELECT * FROM users
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN created_at END DESC,
    CASE WHEN @sort_by = 'username_asc' THEN username END ASC,
    CASE WHEN @sort_by = 'username_desc' THEN username END DESC,
    CASE WHEN @sort_by = 'email_asc' THEN email END ASC,
    CASE WHEN @sort_by = 'email_desc' THEN email END DESC,
    CASE WHEN @sort_by = 'role_asc' THEN role END ASC,
    CASE WHEN @sort_by = 'role_desc' THEN role END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN id END DESC,
    id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListMembers :many
-- The Users screen (#333): ListUsers' sorts, plus a search (pattern: an ILIKE pattern
-- the API escapes, '' = all) over name, username and email, a role filter ('' = all),
-- and each member's posts owned (posts.user_id, every type and status), counted in the
-- same query.
SELECT sqlc.embed(u),
    (SELECT count(*) FROM posts p WHERE p.user_id = u.id)::bigint AS posts_owned
FROM users u
WHERE (sqlc.arg(pattern)::text = ''
        OR u.full_name ILIKE sqlc.arg(pattern)
        OR u.username ILIKE sqlc.arg(pattern)
        OR u.email ILIKE sqlc.arg(pattern))
    AND (sqlc.arg(role)::text = '' OR lower(u.role) = lower(sqlc.arg(role)))
ORDER BY
    CASE WHEN sqlc.arg(sort_by)::text = 'date_asc' THEN u.created_at END ASC,
    CASE WHEN sqlc.arg(sort_by)::text = 'date_desc' THEN u.created_at END DESC,
    CASE WHEN sqlc.arg(sort_by)::text = 'username_asc' THEN u.username END ASC,
    CASE WHEN sqlc.arg(sort_by)::text = 'username_desc' THEN u.username END DESC,
    CASE WHEN sqlc.arg(sort_by)::text = 'email_asc' THEN u.email END ASC,
    CASE WHEN sqlc.arg(sort_by)::text = 'email_desc' THEN u.email END DESC,
    CASE WHEN sqlc.arg(sort_by)::text = 'role_asc' THEN u.role END ASC,
    CASE WHEN sqlc.arg(sort_by)::text = 'role_desc' THEN u.role END DESC,
    CASE WHEN sqlc.arg(sort_by)::text = 'id_asc' THEN u.id END ASC,
    CASE WHEN sqlc.arg(sort_by)::text = 'id_desc' THEN u.id END DESC,
    u.id DESC
LIMIT sqlc.arg(limit_count)
OFFSET sqlc.arg(offset_count);

-- name: SearchCommandPaletteUsers :many
-- The admin command palette (#41): members whose name or username contains the text
-- (@pattern, @prefix_pattern: ILIKE patterns the API escapes), those that start with it
-- first. Not the email: the row doesn't show one, so a hit on "co" (every .com address)
-- would list people for no visible reason.
SELECT u.id, u.username, u.full_name, u.avatar_url, u.role
FROM users u
WHERE u.full_name ILIKE @pattern::text OR u.username ILIKE @pattern::text
ORDER BY (u.full_name ILIKE @prefix_pattern::text OR u.username ILIKE @prefix_pattern::text) DESC, lower(u.full_name), u.id
LIMIT @limit_count::int;

-- name: CountMembers :one
-- ListMembers' filters, for its total.
SELECT count(*) FROM users u
WHERE (sqlc.arg(pattern)::text = ''
        OR u.full_name ILIKE sqlc.arg(pattern)
        OR u.username ILIKE sqlc.arg(pattern)
        OR u.email ILIKE sqlc.arg(pattern))
    AND (sqlc.arg(role)::text = '' OR lower(u.role) = lower(sqlc.arg(role)));

-- name: TouchUserLastActive :execrows
-- Stamps last_active_at unless it is newer than min_age_seconds, so concurrent
-- requests and the API's own check (authMiddleware) write at most once per interval.
-- A row another transaction holds (a role change locks every admin, a password change
-- its user) is skipped rather than waited for: the request carries on, and a later one
-- stamps it.
UPDATE users
SET last_active_at = now()
WHERE id = (
    SELECT u.id FROM users u
    WHERE u.id = sqlc.arg(id)
        AND (u.last_active_at IS NULL
            OR u.last_active_at < now() - make_interval(secs => sqlc.arg(min_age_seconds)::float8))
    FOR UPDATE SKIP LOCKED
);

-- name: SetUserRole :one
UPDATE users
SET role = sqlc.arg(role)
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: LockUsersForUpdate :many
-- Row-locks the given users in id order (RemoveUserTx: the member and the one who
-- receives their posts), so two removals that name each other can't deadlock.
SELECT id, username, avatar_url, role FROM users
WHERE id = ANY(sqlc.arg(ids)::bigint[])
ORDER BY id
FOR UPDATE;

-- name: ReassignPostsOwner :many
-- reassignPostOwner (post_owner_tx.go), for a removal (#333: every post @from_id owns,
-- @all_posts) and a transfer (#353: the posts in @post_ids, if @from_id still owns them).
UPDATE posts
SET user_id = sqlc.arg(to_id), username = sqlc.arg(to_username)
WHERE user_id = sqlc.arg(from_id)
    AND (sqlc.arg(all_posts)::bool OR id = ANY(sqlc.arg(post_ids)::bigint[]))
RETURNING id;

-- name: ReassignPostBylines :exec
-- The old owner's byline (user_posts, #319) on the posts that just moved goes to the
-- new owner, unless they are already credited there (then DeletePostBylineCredits drops
-- it). Used by a removal (#333) and by a transfer that replaces the old owner (#353).
UPDATE user_posts up
SET user_id = sqlc.arg(to_id)
WHERE up.user_id = sqlc.arg(from_id)
    AND up.post_id = ANY(sqlc.arg(post_ids)::bigint[])
    AND NOT EXISTS (
        SELECT 1 FROM user_posts o WHERE o.post_id = up.post_id AND o.user_id = sqlc.arg(to_id)
    );

-- name: DeleteUserBylines :many
-- Removal (#333, #319), after ReassignPostBylines: the member's remaining credits,
-- returning the posts they were on (CreditOwnersOnEmptyBylines).
DELETE FROM user_posts
WHERE user_id = $1
RETURNING post_id;

-- name: CreditOwnersOnEmptyBylines :exec
-- A byline is never empty (#319): a post whose only credit was the removed member
-- credits its owner.
INSERT INTO user_posts (post_id, user_id, "order")
SELECT p.id, p.user_id, 0
FROM posts p
WHERE p.id = ANY(sqlc.arg(post_ids)::bigint[])
    AND NOT EXISTS (SELECT 1 FROM user_posts up WHERE up.post_id = p.id);

-- name: ReassignPublishedBylines :exec
-- Removal (#333, #319): the same rewrite for the published bylines
-- (published_settings.author_ids), at once rather than on the next Update, since
-- the member's credit can't be shown without the account. On the posts that moved
-- (@moved_post_ids, now owned by @to_id) the member's place goes to @to_id unless
-- they are already credited; elsewhere it is dropped; an empty byline becomes the
-- owner. Working and published bylines get the same rule, so a post that had no
-- pending change has none after. post_published_authors follows by trigger.
WITH affected AS (
    SELECT p.id, p.user_id AS owner_id, p.published_settings->'author_ids' AS ids,
        (p.id = ANY(sqlc.arg(moved_post_ids)::bigint[])
            AND NOT ((p.published_settings->'author_ids') @> to_jsonb(sqlc.arg(to_id)::bigint))) AS take_place
    FROM posts p
    -- post_published_authors mirrors author_ids (by trigger) and is indexed by user.
    WHERE p.id IN (SELECT ppa.post_id FROM post_published_authors ppa WHERE ppa.user_id = sqlc.arg(from_id)::bigint)
        AND jsonb_typeof(p.published_settings->'author_ids') = 'array'
)
UPDATE posts p
SET published_settings = jsonb_set(p.published_settings, '{author_ids}', coalesce((
        SELECT jsonb_agg(
            CASE WHEN e.value = to_jsonb(sqlc.arg(from_id)::bigint) THEN to_jsonb(sqlc.arg(to_id)::bigint) ELSE e.value END
            ORDER BY e.ord)
        FROM jsonb_array_elements(a.ids) WITH ORDINALITY AS e(value, ord)
        WHERE a.take_place OR e.value <> to_jsonb(sqlc.arg(from_id)::bigint)
    ), jsonb_build_array(a.owner_id)))
FROM affected a
WHERE p.id = a.id;

-- name: UpdateUser :one
UPDATE users 
SET 
    username = COALESCE($2, username),
    full_name = COALESCE($3, full_name),
    email = COALESCE($4, email),
    hashed_password = COALESCE($5, hashed_password),
    password_changed_at = COALESCE($6, password_changed_at),
    role = COALESCE($7, role),
    -- NULL keeps the stored value (#350); '' clears it.
    bio = COALESCE(sqlc.narg(bio), bio),
    website = COALESCE(sqlc.narg(website), website)
WHERE id = $1
RETURNING *;

-- name: SetUserPassword :one
UPDATE users
SET
    hashed_password = $2,
    password_changed_at = $3
WHERE id = $1
RETURNING *;

-- name: DeleteUser :exec
DELETE FROM users
WHERE id = $1;

-- name: DeleteUserSessions :exec
DELETE FROM sessions
WHERE username = (SELECT username FROM users WHERE users.id = $1);

-- name: UpdatePostsUsername :exec
UPDATE posts
SET username = $2
WHERE user_id = $1;

-- name: CountTotalUsers :one
SELECT COUNT(*) AS total FROM users;

-- name: LockAdminUserIDs :many
-- Row-locks every admin so concurrent admin-removing transactions serialize
-- (COUNT(*) cannot be combined with FOR UPDATE). Ordered by id so lockers
-- acquire in the same order and cannot deadlock each other.
SELECT id FROM users
WHERE lower(role) = 'admin'
ORDER BY id
FOR UPDATE;
-- name: LockUserForUpdate :exec
-- Serializes a password change against concurrent refresh-token rotation
-- (see UpdateUserTx and LockUserForShare).
SELECT id FROM users WHERE id = $1 FOR UPDATE;

-- name: LockUserForShare :exec
-- Taken by refresh-token rotation so it cannot interleave with a password
-- change on the same user (which holds the row FOR UPDATE).
SELECT id FROM users WHERE id = $1 FOR SHARE;
-- name: SetUserEmail :one
UPDATE users
SET email = $2
WHERE id = $1
RETURNING *;

-- name: SetUserAvatar :one
-- Sets (or, with '', removes) the avatar and returns the one it replaced, so the
-- API can delete that file after the commit. The row lock makes two uploads at
-- once each see the other's file as the previous one, so neither leaks.
UPDATE users u
SET avatar_url = sqlc.arg(avatar_url)
FROM (SELECT p.id, p.avatar_url FROM users p WHERE p.id = sqlc.arg(user_id) FOR UPDATE) prev
WHERE u.id = prev.id
RETURNING prev.avatar_url::text AS previous_avatar_url;