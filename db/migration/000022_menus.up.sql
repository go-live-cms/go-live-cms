-- Navigation menus (#347).
--
-- A menu is a named list of links. Themes declare locations ("primary",
-- "footer", in theme.config.ts) and a menu is assigned to at most one of them;
-- each location holds at most one menu.
CREATE TABLE "menus" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar NOT NULL,
  "location" varchar NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "changed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_menus_location" ON "menus" ("location") WHERE "location" IS NOT NULL;

-- A menu's links. An item points at a post (any type, pages included), a
-- taxonomy term, a post type's archive, or a custom URL. Only custom items store
-- a URL: the others are resolved when the menu is read, so they follow slug
-- changes, and items whose content is gone or not public are left out then.
--
-- sort_order is the item's position in the whole menu (parents and children in
-- reading order), not among its siblings. Deleting a post deletes its items
-- (ON DELETE CASCADE); their children lose their parent (SET NULL) and, thanks
-- to that ordering, stay where they were, one level up.
--
-- The API allows one level of nesting; label '' means "use the target's title".
CREATE TABLE "menu_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "menu_id" bigint NOT NULL REFERENCES "menus" ("id") ON DELETE CASCADE,
  "parent_id" bigint NULL REFERENCES "menu_items" ("id") ON DELETE SET NULL,
  "sort_order" int NOT NULL DEFAULT 0,
  "item_type" varchar NOT NULL CHECK ("item_type" IN ('post', 'term', 'archive', 'custom')),
  "label" varchar NOT NULL DEFAULT '',
  "post_id" bigint NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "term_id" bigint NULL REFERENCES "taxonomy_terms" ("id") ON DELETE CASCADE,
  "post_type" varchar NULL REFERENCES "post_types" ("name") ON UPDATE CASCADE ON DELETE CASCADE,
  "url" varchar NOT NULL DEFAULT '',
  -- Exactly the column its type needs.
  CONSTRAINT "menu_items_target" CHECK (
    ("item_type" = 'post') = ("post_id" IS NOT NULL)
    AND ("item_type" = 'term') = ("term_id" IS NOT NULL)
    AND ("item_type" = 'archive') = ("post_type" IS NOT NULL)
    AND ("item_type" = 'custom') = ("url" <> '')
  )
);

CREATE INDEX "idx_menu_items_menu" ON "menu_items" ("menu_id", "sort_order");
-- For the cascades above.
CREATE INDEX "idx_menu_items_parent" ON "menu_items" ("parent_id") WHERE "parent_id" IS NOT NULL;
CREATE INDEX "idx_menu_items_post" ON "menu_items" ("post_id") WHERE "post_id" IS NOT NULL;
CREATE INDEX "idx_menu_items_term" ON "menu_items" ("term_id") WHERE "term_id" IS NOT NULL;
CREATE INDEX "idx_menu_items_post_type" ON "menu_items" ("post_type") WHERE "post_type" IS NOT NULL;
