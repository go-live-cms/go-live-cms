-- name: GetNextVersionNoForPost :one
SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
FROM post_versions
WHERE post_id = $1;

-- name: InsertPostVersion :one
INSERT INTO post_versions (post_id, version_no, status, label, message, block_doc, created_by)
VALUES ($1, $2, 'published', $3, $4, $5, $6)
RETURNING id, version_no;

-- name: LockPostForPublish :one
-- Publish runs in one transaction from here (PublishPostTx): two publishes of
-- one post queue on this lock instead of racing for the same version_no.
SELECT id FROM posts WHERE id = $1 FOR UPDATE;

-- name: InsertPublishedVersionFromPost :one
-- The new version is the post's working copy as stored now: block_doc and its
-- settings (title, excerpt, featured image, terms; golive_post_settings, #358),
-- read in the same statement so they belong together.
INSERT INTO post_versions (post_id, version_no, status, label, message, block_doc, settings, created_by)
SELECT p.id, sqlc.arg(version_no)::int, 'published', sqlc.narg(label)::text, sqlc.narg(message)::text, p.block_doc,
       golive_post_settings(p.id), sqlc.narg(created_by)::bigint
FROM posts p
WHERE p.id = sqlc.arg(post_id)::bigint
RETURNING id, version_no, block_doc;

-- name: SetPublishedVersionOnPost :exec
-- Publishing also makes the post public: post_status follows the snapshot, so a
-- post published from the editor is not left as 'draft' in the database. The
-- published settings are the version's (#358); without a version (a post created
-- as published, the dev seed) they are the post's current ones.
UPDATE posts
SET published_version_id = sqlc.narg(published_version_id)::bigint,
    published_block_doc = sqlc.narg(published_block_doc)::jsonb,
    published_settings = COALESCE(
        (SELECT v.settings FROM post_versions v WHERE v.id = sqlc.narg(published_version_id)::bigint),
        golive_post_settings(posts.id)
    ),
    post_status = 'published'
WHERE id = sqlc.arg(id)::bigint;

-- name: UnpublishPost :one
-- Back to draft and drop the public snapshot (#136), settings included (#358).
-- The snapshot stays in post_versions, so it can still be viewed and restored.
UPDATE posts
SET post_status = 'draft',
    published_version_id = NULL,
    published_block_doc = NULL,
    published_settings = NULL
WHERE id = $1
RETURNING *;

-- name: GetPostVersions :many
-- One statement, so the post's status/published version and its versions are read
-- consistently. Starts from posts: no rows = no post; a single row with a NULL
-- version id = a post without versions.
SELECT p.post_status, p.published_version_id,
       v.id AS version_id, v.version_no, v.status, v.label, v.message, v.created_at, v.created_by,
       u.username AS created_by_username
FROM posts p
LEFT JOIN post_versions v ON v.post_id = p.id
LEFT JOIN users u ON u.id = v.created_by
WHERE p.id = $1
ORDER BY v.version_no DESC NULLS LAST;

-- name: GetPostVersion :one
SELECT v.id, v.version_no, v.status, v.label, v.message, v.block_doc, v.settings, v.created_at, v.created_by,
       u.username AS created_by_username
FROM post_versions v
LEFT JOIN users u ON u.id = v.created_by
WHERE v.post_id = $1
  AND v.version_no = $2;

-- name: GetPostSettingsState :one
-- The editor's view of a post's settings (#358): the working ones, the published
-- ones (NULL when nothing is published) and whether they differ, i.e. whether a
-- settings change is waiting for Update. The published term ids are compared as
-- post_published_terms has them: a term deleted since the publish is gone from
-- both sides (it can't be shown or published), not a pending change.
SELECT w.settings::jsonb AS working,
       p.published_settings,
       (p.published_settings IS NOT NULL
        AND jsonb_set(p.published_settings, '{term_ids}', coalesce((
              SELECT jsonb_agg(ppt.taxonomy_term_id ORDER BY ppt.taxonomy_term_id)
              FROM post_published_terms ppt
              WHERE ppt.post_id = p.id
            ), '[]'::jsonb)) IS DISTINCT FROM w.settings)::boolean AS changed
FROM posts p
CROSS JOIN LATERAL (SELECT golive_post_settings(p.id) AS settings) w
WHERE p.id = $1;

-- name: RefreshPublishedSettings :exec
-- The dev seed (#358): published posts whose terms and featured images were linked
-- after they were published get them in their published settings.
UPDATE posts
SET published_settings = golive_post_settings(id)
WHERE id = ANY(sqlc.arg(ids)::bigint[])
  AND published_settings IS NOT NULL;

-- name: GetPublishedPostTaxonomyTerms :many
-- The terms a published post shows on the site (#358): its published set, in the
-- shape of GetPostTaxonomyTerms.
SELECT tt.*, ttype.name as taxonomy_type_name, ttype.hierarchical
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
JOIN post_published_terms ppt ON tt.id = ppt.taxonomy_term_id
WHERE ppt.post_id = $1
ORDER BY ttype.name, tt.name;

-- name: AddExistingTermsToPost :exec
-- Restoring a version's settings (#358), after RemoveAllPostTaxonomies: link the
-- given terms that still exist. Deleted terms are skipped, not an error.
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
SELECT sqlc.arg(post_id)::bigint, tt.id
FROM taxonomy_terms tt
WHERE tt.id = ANY(sqlc.arg(term_ids)::bigint[]);

-- name: RestorePostTitleAndDescription :one
-- Restoring a version's settings (#358): the working title and excerpt. Only the
-- working copy changes; the published settings stay until Update.
UPDATE posts
SET title = $2,
    description = $3,
    changed_at = now()
WHERE id = $1
RETURNING *;

-- name: GetLatestPublishedVersion :one
SELECT id, version_no, status, label, message, block_doc, created_at, created_by
FROM post_versions
WHERE post_id = $1
  AND status = 'published'
ORDER BY version_no DESC
LIMIT 1;
