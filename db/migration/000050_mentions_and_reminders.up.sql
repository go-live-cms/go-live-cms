-- @ mentions and date reminders (#320). Mentions, content links and date chips are
-- inline nodes inside a post's block_doc (web/gl-admin/lib/blocks-spec/inlineNodes.ts);
-- these two tables are what the API keeps about them, written only by a collab store
-- that writes block_doc (PUT /internal/posts/:id/collab, in StorePostCollabTx), never by
-- a client.
--
-- post_mention_notifications is the dedupe ledger: one row per (post, member) ever
-- mentioned in it, so a member hears about a post at most once however often its blocks
-- are edited, stored, split, moved or pasted (a split or a paste gives the text a new
-- block id, so a per-block key would mail again). block_id is where the first mention
-- was. It is written in the store's own transaction (StorePostCollabTx). `emailed` is set
-- once the email went out; it stays false when none was due (the member can't read the
-- post, mentioned themselves, or nobody typed the mention in that store, e.g. a
-- duplicated post's content) or sending failed. A row is never emailed later. Nothing
-- here reaches the public site.
CREATE TABLE "post_mention_notifications" (
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "block_id" text NOT NULL
    CONSTRAINT "post_mention_notifications_block_id" CHECK (char_length("block_id") BETWEEN 1 AND 128),
  "user_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  -- Who typed it (the block's editor in that store, #328). SET NULL on removal.
  "mentioned_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "emailed" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("post_id", "user_id")
);

CREATE INDEX "idx_post_mention_notifications_user" ON "post_mention_notifications" ("user_id");
CREATE INDEX "idx_post_mention_notifications_by" ON "post_mention_notifications" ("mentioned_by");

-- post_reminders: the reminder chips of each post's working copy, kept in step with every
-- collab store that writes block_doc (a chip removed or moved to another time takes its
-- pending row with it). The scheduler (scheduled_publish.go) emails `user_id` at
-- `remind_at` and marks the row; a sent or skipped row stays, so the same chip never
-- fires twice. `user_id` is whoever wrote the chip (the block's editor in the store that
-- first had it, #328), never a value from the document.
CREATE TABLE "post_reminders" (
  "id" bigserial PRIMARY KEY,
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "block_id" text NOT NULL
    CONSTRAINT "post_reminders_block_id" CHECK (char_length("block_id") BETWEEN 1 AND 128),
  "remind_at" timestamptz NOT NULL,
  -- The chip's own day and time as written (site time), for the email.
  "chip_date" date NOT NULL,
  "chip_time" text NOT NULL
    CONSTRAINT "post_reminders_chip_time" CHECK ("chip_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "user_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending'
    CONSTRAINT "post_reminders_status" CHECK ("status" IN ('pending', 'sent', 'skipped', 'failed')),
  -- The claim's lease while a replica sends it (the fencing token, as #147's).
  "claimed_until" timestamptz NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "done_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- A chip is its block, day and time as written (not the instant: a change of the site's
  -- time zone moves remind_at, never the reminder's identity).
  CONSTRAINT "post_reminders_once" UNIQUE ("post_id", "block_id", "chip_date", "chip_time")
);

CREATE INDEX "idx_post_reminders_due" ON "post_reminders" ("remind_at") WHERE "status" = 'pending';
CREATE INDEX "idx_post_reminders_user" ON "post_reminders" ("user_id");
