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

CREATE TABLE "user_posts" (
  "post_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "order" int NOT NULL DEFAULT 0
);

CREATE TABLE "taxonomies" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar NOT NULL,
  "description" varchar NOT NULL
);

CREATE TABLE "posts_taxonomies" (
  "post_id" bigint NOT NULL,
  "taxonomy_id" bigint NOT NULL
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
CREATE UNIQUE INDEX "unique_post_taxonomy" ON "posts_taxonomies" ("post_id", "taxonomy_id");
CREATE UNIQUE INDEX "unique_post_media" ON "post_media" ("post_id", "media_id");

CREATE INDEX "idx_posts_type" ON "posts" ("post_type");
CREATE INDEX "idx_posts_status" ON "posts" ("post_status");
CREATE INDEX "idx_posts_parent" ON "posts" ("post_parent");
CREATE INDEX "idx_post_meta_post_id" ON "post_meta" ("post_id");
CREATE INDEX "idx_post_meta_key" ON "post_meta" ("meta_key");
CREATE INDEX "idx_post_meta_key_value" ON "post_meta" ("meta_key", "meta_value");

ALTER TABLE "posts_taxonomies" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "user_posts" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "user_posts" ADD FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "posts_taxonomies" ADD FOREIGN KEY ("taxonomy_id") REFERENCES "taxonomies" ("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD FOREIGN KEY ("username") REFERENCES "users" ("username");
ALTER TABLE "post_media" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "post_media" ADD FOREIGN KEY ("media_id") REFERENCES "media" ("id") ON DELETE CASCADE;
ALTER TABLE "media" ADD FOREIGN KEY ("user_id") REFERENCES "users" ("id");

ALTER TABLE "posts" ADD FOREIGN KEY ("post_parent") REFERENCES "posts" ("id") ON DELETE SET NULL;
ALTER TABLE "post_meta" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;
ALTER TABLE "post_meta" ADD CONSTRAINT "unique_post_meta_key" UNIQUE ("post_id", "meta_key");

INSERT INTO "post_types" ("name", "label", "description", "hierarchical", "has_archive", "menu_position", "supports") VALUES
('post', 'Posts', 'Blog posts and articles', false, true, 5, '["title","content","description","author","taxonomies","media"]'::jsonb),
('page', 'Pages', 'Static pages', true, false, 20, '["title","content","description","author","media","parent","menu_order"]'::jsonb);