-- Taxonomy Types Management
-- name: CreateTaxonomyType :one
INSERT INTO taxonomy_types (name, label, description, hierarchical, public, show_ui, show_in_menu)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: GetTaxonomyType :one
SELECT * FROM taxonomy_types WHERE name = $1 LIMIT 1;

-- name: GetTaxonomyTypeByID :one
SELECT * FROM taxonomy_types WHERE id = $1 LIMIT 1;

-- name: ListTaxonomyTypes :many
SELECT * FROM taxonomy_types ORDER BY name;

-- name: UpdateTaxonomyType :one
UPDATE taxonomy_types
SET label = COALESCE($2, label),
    description = COALESCE($3, description),
    hierarchical = COALESCE($4, hierarchical),
    public = COALESCE($5, public),
    show_ui = COALESCE($6, show_ui),
    show_in_menu = COALESCE($7, show_in_menu)
WHERE name = $1
RETURNING *;

-- name: DeleteTaxonomyType :exec
DELETE FROM taxonomy_types WHERE name = $1;

-- Taxonomy Terms Management
-- name: CreateTaxonomyTerm :one
INSERT INTO taxonomy_terms (name, slug, description, parent_id, taxonomy_type_id, sort_order, meta)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: GetTaxonomyTerm :one
SELECT * FROM taxonomy_terms WHERE id = $1 LIMIT 1;

-- name: GetTaxonomyTermBySlug :one
SELECT tt.*, ttype.name as taxonomy_type_name, ttype.hierarchical
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
WHERE tt.slug = $1 LIMIT 1;

-- name: ListTaxonomyTermsByType :many
SELECT tt.*, ttype.name as taxonomy_type_name, ttype.hierarchical,
    (SELECT COUNT(*) FROM post_taxonomy_relationships ptr WHERE ptr.taxonomy_term_id = tt.id) AS post_count
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
WHERE ttype.name = $1
ORDER BY
    CASE WHEN @sort_by = 'name_asc' THEN tt.name END ASC,
    CASE WHEN @sort_by = 'name_desc' THEN tt.name END DESC,
    CASE WHEN @sort_by = 'order_asc' THEN tt.sort_order END ASC,
    CASE WHEN @sort_by = 'order_desc' THEN tt.sort_order END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN tt.id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN tt.id END DESC,
    tt.sort_order ASC, tt.name ASC
LIMIT @limit_count OFFSET @offset_count;

-- name: GetTaxonomyTermsWithPostCount :many
SELECT 
    tt.*,
    ttype.name as taxonomy_type_name,
    ttype.hierarchical,
    COUNT(ptr.post_id) as post_count
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
LEFT JOIN post_taxonomy_relationships ptr ON tt.id = ptr.taxonomy_term_id
WHERE ttype.name = $1
GROUP BY tt.id, tt.name, tt.slug, tt.description, tt.parent_id, tt.taxonomy_type_id, tt.sort_order, tt.meta, tt.created_at, ttype.name, ttype.hierarchical
ORDER BY tt.sort_order ASC, tt.name ASC
LIMIT @limit_count OFFSET @offset_count;

-- name: GetTermChildren :many
SELECT * FROM taxonomy_terms 
WHERE parent_id = $1 
ORDER BY sort_order ASC, name ASC;

-- name: GetTermParents :many
SELECT t1.*
FROM taxonomy_terms t1
JOIN taxonomy_terms t2 ON t1.id = t2.parent_id
WHERE t2.id = $1
ORDER BY t1.id;


-- Hierarchical term tree (for categories)
-- name: GetTaxonomyTermTree :many
WITH RECURSIVE term_tree AS (
    -- Root terms
    SELECT tt.*, ttype.name as taxonomy_type_name, 0 as level
    FROM taxonomy_terms tt
    JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
    WHERE tt.parent_id IS NULL AND ttype.name = $1
    
    UNION ALL
    
    -- Child terms
    SELECT tt.*, tree.taxonomy_type_name, tree.level + 1
    FROM taxonomy_terms tt
    JOIN term_tree tree ON tt.parent_id = tree.id
)
SELECT * FROM term_tree ORDER BY level, sort_order, name;

-- name: UpdateTaxonomyTerm :one
-- parent_id is assigned as is (no COALESCE) so a NULL moves the term to the top
-- level; the handler passes the current parent when it isn't changing.
UPDATE taxonomy_terms
SET name = COALESCE($2, name),
    slug = COALESCE($3, slug),
    description = COALESCE($4, description),
    parent_id = $5,
    sort_order = COALESCE($6, sort_order),
    meta = COALESCE($7, meta)
WHERE id = $1
RETURNING *;

-- name: DeleteTaxonomyTerm :exec
DELETE FROM taxonomy_terms WHERE id = $1;

-- Post-Taxonomy Relationships
-- name: AddPostToTaxonomyTerm :one
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
VALUES ($1, $2) RETURNING *;

-- name: RemovePostFromTaxonomyTerm :exec
DELETE FROM post_taxonomy_relationships
WHERE post_id = $1 AND taxonomy_term_id = $2;

-- name: RemoveAllPostTaxonomies :exec
DELETE FROM post_taxonomy_relationships WHERE post_id = $1;

-- name: GetPostTaxonomyTerms :many
SELECT tt.*, ttype.name as taxonomy_type_name, ttype.hierarchical
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
JOIN post_taxonomy_relationships ptr ON tt.id = ptr.taxonomy_term_id
WHERE ptr.post_id = $1
ORDER BY ttype.name, tt.name;

-- name: GetPostsByTaxonomyTerm :many
SELECT p.*
FROM posts p
JOIN post_taxonomy_relationships ptr ON p.id = ptr.post_id
WHERE ptr.taxonomy_term_id = $1
    AND ($2 = '' OR p.post_status = $2)
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN p.created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN p.created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN p.title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN p.title END DESC,
    p.created_at DESC
LIMIT @limit_count OFFSET @offset_count;

-- name: GetPostsByMultipleTaxonomyTerms :many
SELECT DISTINCT p.*
FROM posts p
JOIN post_taxonomy_relationships ptr ON p.id = ptr.post_id
WHERE ptr.taxonomy_term_id = ANY($1::bigint[])
    AND ($2 = '' OR p.post_status = $2)
ORDER BY p.created_at DESC
LIMIT @limit_count OFFSET @offset_count;

-- Search and filtering
-- name: SearchTaxonomyTerms :many
SELECT tt.*, ttype.name as taxonomy_type_name
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
WHERE ttype.name = $1 
    AND (tt.name ILIKE '%' || $2 || '%' OR tt.description ILIKE '%' || $2 || '%')
ORDER BY tt.name
LIMIT @limit_count OFFSET @offset_count;

-- name: GetPopularTaxonomyTerms :many
SELECT 
    tt.*,
    ttype.name as taxonomy_type_name,
    COUNT(ptr.post_id) as post_count
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
JOIN post_taxonomy_relationships ptr ON tt.id = ptr.taxonomy_term_id
WHERE ttype.name = $1
GROUP BY tt.id, tt.name, tt.slug, tt.description, tt.parent_id, tt.taxonomy_type_id, tt.sort_order, tt.meta, tt.created_at, ttype.name
HAVING COUNT(ptr.post_id) > 0
ORDER BY COUNT(ptr.post_id) DESC
LIMIT $2;

-- Counting functions
-- name: CountTaxonomyTerms :one
SELECT COUNT(*) as total FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON tt.taxonomy_type_id = ttype.id
WHERE ttype.name = $1;

-- name: CountPostsByTaxonomyTerm :one
SELECT COUNT(*) as total FROM post_taxonomy_relationships
WHERE taxonomy_term_id = $1;

-- name: RemoveAllPostTaxonomiesByTerm :exec
DELETE FROM post_taxonomy_relationships WHERE taxonomy_term_id = $1;
-- One category per post, the default category, merges (#331, 000047).

-- name: LockPostForTerms :one
-- Taken first by every write that replaces a post's category, so two writers of one
-- post can't both pass the one-category check (000047's trigger is the backstop).
SELECT id, post_type FROM posts WHERE id = $1 FOR UPDATE;

-- name: RemovePostCategoriesExcept :many
-- Assigning a category replaces the post's other one(s).
DELETE FROM post_taxonomy_relationships ptr
USING taxonomy_terms tt, taxonomy_types ty
WHERE ptr.post_id = @post_id::bigint
  AND tt.id = ptr.taxonomy_term_id AND ty.id = tt.taxonomy_type_id AND ty.name = 'category'
  AND ptr.taxonomy_term_id <> @keep_term_id::bigint
  -- Only when the term assigned is a category itself.
  AND EXISTS (
    SELECT 1 FROM taxonomy_terms k JOIN taxonomy_types kt ON kt.id = k.taxonomy_type_id
    WHERE k.id = @keep_term_id::bigint AND kt.name = 'category'
  )
RETURNING ptr.taxonomy_term_id;

-- name: EnsureDefaultCategory :execrows
-- A post of type "post" without a category gets the default one (Uncategorized). The
-- other types may have none. Called by every writer of a post's terms.
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
SELECT p.id, ty.default_term_id
FROM posts p
JOIN taxonomy_types ty ON ty.name = 'category' AND ty.default_term_id IS NOT NULL
WHERE p.id = ANY(@post_ids::bigint[]) AND p.post_type = 'post'
  AND NOT EXISTS (
    SELECT 1 FROM post_taxonomy_relationships ptr
    JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
    WHERE ptr.post_id = p.id AND tt.taxonomy_type_id = ty.id
  )
ON CONFLICT DO NOTHING;

-- name: CountCategoryTerms :one
-- How many of the given terms are categories (POST/PUT /posts allow one).
SELECT COUNT(DISTINCT tt.id)::bigint
FROM taxonomy_terms tt
JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
WHERE tt.id = ANY(@term_ids::bigint[]) AND ty.name = 'category';

-- name: ListTermPostIDs :many
SELECT post_id FROM post_taxonomy_relationships WHERE taxonomy_term_id = $1 ORDER BY post_id;

-- name: CountTermChildren :one
SELECT COUNT(*)::bigint FROM taxonomy_terms WHERE parent_id = $1;

-- name: ReassignTermPosts :execrows
-- A merge (#331): the source's posts get the target, unless they have it already (the
-- leftover links go with the source term).
UPDATE post_taxonomy_relationships ptr
SET taxonomy_term_id = @target_id::bigint
WHERE ptr.taxonomy_term_id = @source_id::bigint
  AND NOT EXISTS (
    SELECT 1 FROM post_taxonomy_relationships other
    WHERE other.post_id = ptr.post_id AND other.taxonomy_term_id = @target_id::bigint
  );

-- name: ReplaceTermInPublishedSettings :execrows
-- A merge, or a deleted category's posts moving to the default: the published sets
-- (what the site shows) follow at once, like the working ones, so no published post
-- shows a pending change for a taxonomy operation. Sorted and without repeats, like
-- golive_post_settings(). The published-terms trigger mirrors it.
UPDATE posts p
SET published_settings = jsonb_set(p.published_settings, '{term_ids}', (
  SELECT coalesce(jsonb_agg(DISTINCT x.id ORDER BY x.id), '[]'::jsonb)
  FROM (
    SELECT CASE WHEN t.value::bigint = @source_id::bigint THEN @target_id::bigint ELSE t.value::bigint END AS id
    FROM jsonb_array_elements_text(p.published_settings->'term_ids') AS t(value)
    WHERE t.value ~ '^[0-9]{1,18}$'
  ) x
))
WHERE p.published_settings IS NOT NULL
  AND jsonb_typeof(p.published_settings->'term_ids') = 'array'
  AND p.published_settings->'term_ids' @> jsonb_build_array(@source_id::bigint);

-- name: ReplaceTermInScheduledUpdates :execrows
-- The same for pending scheduled updates (#335), which would publish their snapshot.
UPDATE post_scheduled_updates su
SET settings = jsonb_set(su.settings, '{term_ids}', (
  SELECT coalesce(jsonb_agg(DISTINCT x.id ORDER BY x.id), '[]'::jsonb)
  FROM (
    SELECT CASE WHEN t.value::bigint = @source_id::bigint THEN @target_id::bigint ELSE t.value::bigint END AS id
    FROM jsonb_array_elements_text(su.settings->'term_ids') AS t(value)
    WHERE t.value ~ '^[0-9]{1,18}$'
  ) x
))
WHERE jsonb_typeof(su.settings->'term_ids') = 'array'
  AND su.settings->'term_ids' @> jsonb_build_array(@source_id::bigint);

-- name: LinkPostTerm :exec
-- Idempotent link (inside a transaction a unique violation would abort it).
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
VALUES (@post_id, @taxonomy_term_id)
ON CONFLICT DO NOTHING;

-- name: GetPostCategorySlug :one
-- The category slug in one post's URL (golive_post_category_slug, 000047); '' = none.
SELECT coalesce(golive_post_category_slug(@post_id::bigint, @published::boolean), '')::text AS slug;

-- name: IsPostTypeOrTaxonomyName :one
-- A category slug can't be a post type's or taxonomy's name: /{name}/... is that
-- type's or taxonomy's URL, so /:category/:slug would never reach the post (#331).
SELECT (EXISTS (SELECT 1 FROM post_types WHERE name = @name::text)
     OR EXISTS (SELECT 1 FROM taxonomy_types WHERE name = @name::text))::boolean AS taken;
