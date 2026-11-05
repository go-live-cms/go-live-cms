-- Post ownership (#353): TransferPostOwnerTx and the reassignment it shares with a
-- member's removal (RemoveUserTx, #333). See db/sqlc/post_owner_tx.go.

-- name: LockNewPostOwner :one
-- The member about to own a post (#353), FOR KEY SHARE: a concurrent removal (#333,
-- which deletes the row FOR UPDATE) waits for the transfer, or wins and the transfer
-- finds no row. Taken before the post's lock, RemoveUserTx's order (users, then posts).
SELECT id, username, full_name, avatar_url, role FROM users
WHERE id = $1
FOR KEY SHARE;

-- name: LockPostOwner :one
-- The post being transferred (#353), locked: its current owner and status are read
-- under the lock, so two transfers queue instead of both reading the same owner.
SELECT id, user_id, post_status FROM posts
WHERE id = $1
FOR UPDATE;

-- name: DeletePostBylineCredits :exec
-- After ReassignPostBylines: @user_id's credit left on @post_ids (the new owner was
-- already credited there, so it couldn't take their place). Never empties a byline:
-- each of those posts still credits the new owner.
DELETE FROM user_posts
WHERE user_id = sqlc.arg(user_id)
    AND post_id = ANY(sqlc.arg(post_ids)::bigint[]);
