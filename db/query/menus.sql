-- name: CreateMenu :one
INSERT INTO menus (name, location)
VALUES ($1, $2)
RETURNING *;

-- name: GetMenu :one
SELECT * FROM menus
WHERE id = $1;

-- name: GetMenuForUpdate :one
SELECT * FROM menus
WHERE id = $1
FOR UPDATE;

-- name: GetMenuByLocation :one
SELECT * FROM menus
WHERE location = $1;

-- name: ListMenus :many
SELECT m.*,
  (SELECT count(*) FROM menu_items mi WHERE mi.menu_id = m.id)::bigint AS item_count
FROM menus m
ORDER BY m.name, m.id;

-- name: UpdateMenu :one
UPDATE menus
SET name = $2, location = $3, changed_at = now()
WHERE id = $1
RETURNING *;

-- Frees a location for another menu (assigning a location moves it).
-- name: ClearMenuLocation :exec
UPDATE menus
SET location = NULL, changed_at = now()
WHERE location = $1 AND id <> $2;

-- name: TouchMenu :exec
UPDATE menus
SET changed_at = now()
WHERE id = $1;

-- name: DeleteMenu :execrows
DELETE FROM menus
WHERE id = $1;

-- name: DeleteMenuItems :exec
DELETE FROM menu_items
WHERE menu_id = $1;

-- name: CreateMenuItem :one
INSERT INTO menu_items (menu_id, parent_id, sort_order, item_type, label, post_id, term_id, post_type, url)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- A menu's items with what their URL and visibility are resolved from: the
-- post (and its type), the term (and its taxonomy) or the archive's post type.
-- A target that no longer exists comes back as NULLs.
-- name: ListMenuItemsWithTargets :many
SELECT
  mi.id, mi.menu_id, mi.parent_id, mi.sort_order, mi.item_type, mi.label,
  mi.post_id, mi.term_id, mi.post_type, mi.url,
  p.title AS post_title, p.slug AS post_slug, p.post_type AS post_post_type, p.post_status AS post_status,
  ppt.public AS post_type_public, ppt.is_active AS post_type_active,
  t.name AS term_name, t.slug AS term_slug, tt.name AS taxonomy_name, tt.public AS taxonomy_public,
  apt.label AS archive_label, apt.public AS archive_public, apt.is_active AS archive_active
FROM menu_items mi
LEFT JOIN posts p ON p.id = mi.post_id
LEFT JOIN post_types ppt ON ppt.name = p.post_type
LEFT JOIN taxonomy_terms t ON t.id = mi.term_id
LEFT JOIN taxonomy_types tt ON tt.id = t.taxonomy_type_id
LEFT JOIN post_types apt ON apt.name = mi.post_type
WHERE mi.menu_id = $1
ORDER BY mi.sort_order, mi.id;
