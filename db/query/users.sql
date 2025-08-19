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

-- name: UpdateUser :one
UPDATE users 
SET 
    username = COALESCE($2, username),
    full_name = COALESCE($3, full_name),
    email = COALESCE($4, email),
    hashed_password = COALESCE($5, hashed_password),
    password_changed_at = COALESCE($6, password_changed_at),
    role = COALESCE($7, role)
WHERE id = $1
RETURNING *;

-- name: DeleteUser :exec
DELETE FROM users
WHERE id = $1;

-- name: DeleteUserSessions :exec
DELETE FROM sessions
WHERE username = (SELECT username FROM users WHERE users.id = $1);

-- name: DeleteUserPostsByUserID :exec
DELETE FROM user_posts
WHERE user_id = $1;

-- name: DeletePostsByUserID :exec
DELETE FROM posts
WHERE user_id = $1;

-- name: UpdatePostsUsername :exec
UPDATE posts
SET username = $2
WHERE user_id = $1;

-- name: TransferPostsToAdmin :exec
UPDATE posts 
SET user_id = $2, username = (SELECT username FROM users WHERE id = $2)
WHERE user_id = $1;

-- name: UpdateUserPostsOwnership :exec
UPDATE user_posts 
SET user_id = $2
WHERE user_id = $1;

-- name: CountTotalUsers :one
SELECT COUNT(*) AS total FROM users;