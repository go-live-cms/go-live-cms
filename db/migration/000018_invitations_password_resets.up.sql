-- Invite-only accounts and password reset (#148). Both tables store only the
-- SHA-256 of their tokens: the raw token exists in the email link and nowhere
-- else, so a database leak can't be turned into working links.

CREATE TABLE "user_invitations" (
  "id" bigserial PRIMARY KEY,
  "email" varchar NOT NULL,
  "role" varchar NOT NULL,
  "token_hash" bytea NOT NULL UNIQUE,
  "invited_by" bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "accepted_user_id" bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

-- One open (neither accepted nor revoked) invitation per email. Creating a new
-- one revokes the old one first; resending rotates the token in place.
CREATE UNIQUE INDEX "user_invitations_open_email_idx" ON "user_invitations" ("email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

CREATE TABLE "password_reset_tokens" (
  "id" bigserial PRIMARY KEY,
  "user_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "token_hash" bytea NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" ("user_id");
