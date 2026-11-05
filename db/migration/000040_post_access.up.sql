-- Edit access on someone else's post (#321): a contributor who may only watch a
-- post (view-only, #135) asks for edit access; the post's owner, an editor or an
-- admin grants or declines it; a grant can be revoked.
--
-- post_collaborators is the grant. auth_posts.go reads it (canEditWorkingCopy):
-- a collaborator may edit the post's working copy (a read-write collab
-- connection) while they may read it, i.e. while it is published. A grant never
-- gives read access, the live fields (canEditPostDetails), the byline or the
-- publish rights: the owner is still the owner (posts.user_id).
CREATE TABLE "post_collaborators" (
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "user_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  -- Who granted it; NULL once that member is removed.
  "granted_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("post_id", "user_id")
);

-- A member's grants (the access lookup is by the primary key; this one serves
-- member removal's cascade).
CREATE INDEX "idx_post_collaborators_user" ON "post_collaborators" ("user_id");

-- The requests. One open (pending) request per member and post; a reviewed one
-- stays as the record of the answer (a decline starts the cooldown before the
-- same member may ask again for that post).
CREATE TABLE "post_access_requests" (
  "id" bigserial PRIMARY KEY,
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "requester_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  -- The optional note to the reviewers (plain text, shown in the admin and the
  -- email; never in the activity log).
  "message" text NOT NULL DEFAULT ''
    CONSTRAINT "post_access_requests_message_length" CHECK (char_length("message") <= 500),
  "status" text NOT NULL DEFAULT 'pending'
    CONSTRAINT "post_access_requests_status" CHECK ("status" IN ('pending', 'granted', 'declined')),
  "reviewed_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Pending exactly when nobody has answered it.
  CONSTRAINT "post_access_requests_reviewed" CHECK (("status" = 'pending') = ("reviewed_at" IS NULL))
);

CREATE UNIQUE INDEX "post_access_requests_one_open"
  ON "post_access_requests" ("post_id", "requester_id") WHERE "status" = 'pending';
-- Home's "Needs attention": the open requests, newest first.
CREATE INDEX "idx_post_access_requests_pending"
  ON "post_access_requests" ("created_at" DESC) WHERE "status" = 'pending';
-- A member's requests (the cooldown lookup, member removal's cascade).
CREATE INDEX "idx_post_access_requests_requester"
  ON "post_access_requests" ("requester_id", "post_id");
