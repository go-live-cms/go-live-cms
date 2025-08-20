-- name: CreateTaxonomy :one
INSERT INTO taxonomies (
    name,
    description
) VALUES (
    $1, $2
) RETURNING *;

-- name: GetTaxonomy :one
SELECT * FROM taxonomies
WHERE id = $1 LIMIT 1;

-- name: GetTaxonomyByName :one
SELECT * FROM taxonomies
WHERE name = $1 LIMIT 1;

-- name: ListTaxonomies :many
SELECT * FROM taxonomies
ORDER BY
    CASE WHEN @sort_by = 'name_asc' THEN name END ASC,
    CASE WHEN @sort_by = 'name_desc' THEN name END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN id END DESC,
    name ASC
LIMIT @limit_count
OFFSET @offset_count;

-- name: UpdateTaxonomy :one
UPDATE taxonomies 
SET 
    name = COALESCE($2, name),
    description = COALESCE($3, description)
WHERE id = $1
RETURNING *;

-- name: DeleteTaxonomy :exec
DELETE FROM taxonomies
WHERE id = $1;

-- name: CreatePostTaxonomy :one
INSERT INTO posts_taxonomies (
    post_id,
    taxonomy_id
) VALUES (
    $1, $2
) RETURNING *;

-- name: GetPostTaxonomies :many
SELECT t.* FROM taxonomies t
JOIN posts_taxonomies pt ON t.id = pt.taxonomy_id
WHERE pt.post_id = $1
ORDER BY t.name;

-- name: GetTaxonomyPosts :many
SELECT p.* FROM posts p
JOIN posts_taxonomies pt ON p.id = pt.post_id
WHERE pt.taxonomy_id = $1
ORDER BY p.created_at DESC
LIMIT $2
OFFSET $3;

-- name: DeletePostTaxonomy :exec
DELETE FROM posts_taxonomies
WHERE post_id = $1 AND taxonomy_id = $2;

-- name: DeletePostTaxonomies :exec
DELETE FROM posts_taxonomies
WHERE post_id = $1;

-- name: DeleteTaxonomyPosts :exec
DELETE FROM posts_taxonomies
WHERE taxonomy_id = $1;

-- name: GetPostTaxonomyCount :one
SELECT COUNT(*) FROM posts_taxonomies
WHERE post_id = $1;

-- name: GetTaxonomyPostCount :one
SELECT COUNT(*) FROM posts_taxonomies
WHERE taxonomy_id = $1;

-- name: ListTaxonomiesWithPostCount :many
SELECT 
    t.*,
    COUNT(pt.post_id) as post_count
FROM taxonomies t
LEFT JOIN posts_taxonomies pt ON t.id = pt.taxonomy_id
GROUP BY t.id, t.name, t.description
ORDER BY
    CASE WHEN @sort_by = 'name_asc' THEN t.name END ASC,
    CASE WHEN @sort_by = 'name_desc' THEN t.name END DESC,
    CASE WHEN @sort_by = 'posts_asc' THEN COUNT(pt.post_id) END ASC,
    CASE WHEN @sort_by = 'posts_desc' THEN COUNT(pt.post_id) END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN t.id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN t.id END DESC,
    t.name ASC
LIMIT @limit_count
OFFSET @offset_count;

-- name: GetPopularTaxonomies :many
SELECT 
    t.*,
    COUNT(pt.post_id) as post_count
FROM taxonomies t
JOIN posts_taxonomies pt ON t.id = pt.taxonomy_id
GROUP BY t.id, t.name, t.description
HAVING COUNT(pt.post_id) > 0
ORDER BY COUNT(pt.post_id) DESC
LIMIT $1;

-- name: SearchTaxonomiesByName :many
SELECT * FROM taxonomies
WHERE name ILIKE '%' || $1 || '%'
ORDER BY
    CASE WHEN @sort_by = 'name_asc' THEN name END ASC,
    CASE WHEN @sort_by = 'name_desc' THEN name END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN id END DESC,
    name ASC
LIMIT @limit_count
OFFSET @offset_count;

-- name: CountTotalTaxonomies :one
SELECT COUNT(*) AS total FROM taxonomies;