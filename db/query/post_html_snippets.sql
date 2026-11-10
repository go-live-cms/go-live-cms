-- Custom HTML (#428, 000053). Every query names the post: a snippet id from another post
-- finds nothing.

-- name: ListPostHTMLSnippets :many
SELECT * FROM post_html_snippets
WHERE post_id = $1
ORDER BY created_at, snippet_id;

-- name: CreatePostHTMLSnippet :one
INSERT INTO post_html_snippets (post_id, snippet_id, html)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdatePostHTMLSnippet :one
UPDATE post_html_snippets
SET html = $3, updated_at = now()
WHERE post_id = $1 AND snippet_id = $2
RETURNING *;

-- name: RestorePostHTMLSnippet :exec
-- Restoring a version: the markup it was published with, under the same id, whether the
-- row was edited or deleted since. published_html is left alone: the site doesn't change
-- until Update.
INSERT INTO post_html_snippets (post_id, snippet_id, html)
VALUES ($1, $2, $3)
ON CONFLICT (post_id, snippet_id) DO UPDATE
SET html = EXCLUDED.html, updated_at = now();

-- name: SetPostHTMLSnippetPublished :exec
UPDATE post_html_snippets
SET published_html = $3
WHERE post_id = $1 AND snippet_id = $2;

-- name: ClearPublishedHTMLSnippetsExcept :exec
-- After a publish: rows the published body doesn't use aren't on the site.
UPDATE post_html_snippets
SET published_html = NULL
WHERE post_id = sqlc.arg(post_id)::bigint
  AND published_html IS NOT NULL
  AND NOT (snippet_id = ANY(sqlc.arg(snippet_ids)::text[]));

-- name: SetPostVersionBlockDoc :exec
-- Inside a publish, before the version is used: the working copy with its markup.
UPDATE post_versions SET block_doc = $2 WHERE id = $1;

-- name: SetScheduledUpdateBlockDoc :exec
-- Inside ScheduleUpdateTx: the frozen body with its markup.
UPDATE post_scheduled_updates SET block_doc = $2 WHERE post_id = $1;
