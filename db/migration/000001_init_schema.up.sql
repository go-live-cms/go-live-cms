CREATE TABLE "users" (
  "id" BIGSERIAL PRIMARY KEY,
  "username" varchar UNIQUE NOT NULL,
  "full_name" varchar NOT NULL,
  "email" varchar UNIQUE NOT NULL,
  "hashed_password" varchar NOT NULL,
  "password_changed_at" timestamptz NOT NULL DEFAULT '0001-01-01 00:00:00Z',
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "role" varchar NOT NULL DEFAULT 'User'
);

CREATE TABLE "posts" (
  "id" BIGSERIAL PRIMARY KEY,
  "title" varchar NOT NULL,
  "description" varchar NOT NULL,
  "content" text NOT NULL,
  "user_id" bigint NOT NULL,
  "username" varchar NOT NULL DEFAULT '',
  "url" varchar UNIQUE NOT NULL DEFAULT '',
  "post_type" varchar NOT NULL DEFAULT 'post',
  "post_status" varchar NOT NULL DEFAULT 'published',
  "post_parent" bigint DEFAULT NULL,
  "menu_order" int NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "changed_at" timestamptz NOT NULL DEFAULT '0001-01-01 00:00:00Z'
);

CREATE TABLE "post_meta" (
  "id" BIGSERIAL PRIMARY KEY,
  "post_id" bigint NOT NULL,
  "meta_key" varchar NOT NULL,
  "meta_value" text,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "post_types" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar UNIQUE NOT NULL,
  "label" varchar NOT NULL,
  "description" varchar,
  "public" boolean NOT NULL DEFAULT true,
  "hierarchical" boolean NOT NULL DEFAULT false,
  "has_archive" boolean NOT NULL DEFAULT true,
  "menu_position" int DEFAULT 0,
  "supports" jsonb NOT NULL DEFAULT '["title","content","description"]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "taxonomy_types" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar UNIQUE NOT NULL,           
  "label" varchar NOT NULL,                
  "description" varchar DEFAULT '',
  "hierarchical" boolean NOT NULL DEFAULT false,  
  "public" boolean NOT NULL DEFAULT true,
  "show_ui" boolean NOT NULL DEFAULT true,
  "show_in_menu" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "taxonomy_terms" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar NOT NULL,
  "slug" varchar UNIQUE NOT NULL,
  "description" varchar DEFAULT '',
  "parent_id" bigint DEFAULT NULL,          
  "taxonomy_type_id" bigint NOT NULL,      
  "sort_order" int DEFAULT 0,
  "meta" jsonb DEFAULT '{}'::jsonb,        
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "post_taxonomy_relationships" (
  "post_id" bigint NOT NULL,
  "taxonomy_term_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "user_posts" (
  "post_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "order" int NOT NULL DEFAULT 0
);

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY,
  "user_id" bigint NOT NULL,
  "username" varchar NOT NULL,
  "refresh_token" varchar NOT NULL,
  "user_agent" varchar NOT NULL,
  "client_ip" varchar NOT NULL,
  "is_blocked" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "media" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar NOT NULL,
  "description" varchar NOT NULL,
  "alt" varchar NOT NULL,
  "media_path" varchar NOT NULL,
  "user_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "changed_at" timestamptz NOT NULL DEFAULT '0001-01-01 00:00:00Z',
  "file_size" bigint NOT NULL DEFAULT 0,
  "mime_type" varchar NOT NULL DEFAULT '',
  "width" int NOT NULL DEFAULT 0,
  "height" int NOT NULL DEFAULT 0,
  "duration" int NOT NULL DEFAULT 0,
  "original_filename" varchar NOT NULL DEFAULT '',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE "post_media" (
  "post_id" bigint NOT NULL,
  "media_id" bigint NOT NULL,
  "order" int NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX "unique_post_user" ON "user_posts" ("post_id", "user_id");
CREATE UNIQUE INDEX "unique_post_media" ON "post_media" ("post_id", "media_id");

CREATE INDEX "idx_posts_type" ON "posts" ("post_type");
CREATE INDEX "idx_posts_status" ON "posts" ("post_status");
CREATE INDEX "idx_posts_parent" ON "posts" ("post_parent");

CREATE INDEX "idx_post_meta_post_id" ON "post_meta" ("post_id");
CREATE INDEX "idx_post_meta_key" ON "post_meta" ("meta_key");
CREATE INDEX "idx_post_meta_key_value" ON "post_meta" ("meta_key", "meta_value");

CREATE INDEX "idx_taxonomy_terms_type" ON "taxonomy_terms" ("taxonomy_type_id");
CREATE INDEX "idx_taxonomy_terms_parent" ON "taxonomy_terms" ("parent_id");
CREATE INDEX "idx_taxonomy_terms_slug" ON "taxonomy_terms" ("slug");
CREATE UNIQUE INDEX "unique_post_taxonomy_term" ON "post_taxonomy_relationships" ("post_id", "taxonomy_term_id");

ALTER TABLE "user_posts" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "user_posts" ADD FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD FOREIGN KEY ("username") REFERENCES "users" ("username");
ALTER TABLE "post_media" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "post_media" ADD FOREIGN KEY ("media_id") REFERENCES "media" ("id") ON DELETE CASCADE;
ALTER TABLE "media" ADD FOREIGN KEY ("user_id") REFERENCES "users" ("id");

ALTER TABLE "posts" ADD FOREIGN KEY ("post_parent") REFERENCES "posts" ("id") ON DELETE SET NULL;
ALTER TABLE "post_meta" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;

ALTER TABLE "taxonomy_terms" ADD FOREIGN KEY ("parent_id") REFERENCES "taxonomy_terms" ("id") ON DELETE SET NULL;
ALTER TABLE "taxonomy_terms" ADD FOREIGN KEY ("taxonomy_type_id") REFERENCES "taxonomy_types" ("id") ON DELETE CASCADE;
ALTER TABLE "post_taxonomy_relationships" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "post_taxonomy_relationships" ADD FOREIGN KEY ("taxonomy_term_id") REFERENCES "taxonomy_terms" ("id") ON DELETE CASCADE;

ALTER TABLE "post_meta" ADD CONSTRAINT "unique_post_meta_key" UNIQUE ("post_id", "meta_key");

-- Default data
INSERT INTO "post_types" ("name", "label", "description", "hierarchical", "has_archive", "menu_position", "supports") VALUES
('post', 'Posts', 'Blog posts and articles', false, true, 5, '["title","content","description","author","taxonomies","media"]'::jsonb),
('page', 'Pages', 'Static pages', true, false, 20, '["title","content","description","author","media","parent","menu_order"]'::jsonb);

-- Default taxonomy types
INSERT INTO "taxonomy_types" ("name", "label", "description", "hierarchical") VALUES
('category', 'Categories', 'Post categories for organizing content', true),
('tag', 'Tags', 'Post tags for labeling content', false),
('page_category', 'Page Categories', 'Categories for organizing pages', true);

