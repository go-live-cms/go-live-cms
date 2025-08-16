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
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "changed_at" timestamptz NOT NULL DEFAULT '0001-01-01 00:00:00Z'
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

ALTER TABLE "posts_taxonomies" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id");

ALTER TABLE "user_posts" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id");

ALTER TABLE "user_posts" ADD FOREIGN KEY ("user_id") REFERENCES "users" ("id");

ALTER TABLE "posts_taxonomies" ADD FOREIGN KEY ("taxonomy_id") REFERENCES "taxonomies" ("id");

ALTER TABLE "sessions" ADD FOREIGN KEY ("username") REFERENCES "users" ("username");

ALTER TABLE "post_media" ADD FOREIGN KEY ("post_id") REFERENCES "posts" ("id");

ALTER TABLE "post_media" ADD FOREIGN KEY ("media_id") REFERENCES "media" ("id");

ALTER TABLE "media" ADD FOREIGN KEY ("user_id") REFERENCES "users" ("id");
