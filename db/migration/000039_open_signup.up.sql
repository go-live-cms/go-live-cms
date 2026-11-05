-- Optional open signup (#191).

-- "Allow anyone to sign up" (Settings › General). Off by default: accounts come
-- from invitations (#148) unless an admin opens signup.
ALTER TABLE "settings" ADD COLUMN "allow_signup" boolean NOT NULL DEFAULT false;

-- A signup waiting for its email to be confirmed. There is no user row until the
-- emailed link is used (ConfirmSignupTx), so an unconfirmed signup can't sign in,
-- and it can't hold a username or an address another person (or an invitation)
-- needs: the first to confirm gets them.
--
-- Like invitations, password resets (000018) and email changes (000038), only the
-- token's SHA-256 is stored, it expires, and it is single use: redeeming it deletes
-- the row (ClaimSignupRequest). The password is the bcrypt hash the account will get.
-- A newer signup for the same email replaces the older one, and expired rows are
-- deleted hourly and whenever a new one is stored (DeleteStaleSignupRequests), so
-- unconfirmed details don't pile up.
CREATE TABLE "signup_requests" (
  "id" bigserial PRIMARY KEY,
  "email" varchar NOT NULL,
  "username" varchar NOT NULL,
  "full_name" varchar NOT NULL,
  "hashed_password" varchar NOT NULL,
  "token_hash" bytea NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE INDEX "signup_requests_email_idx" ON "signup_requests" ("email");
CREATE INDEX "signup_requests_expires_at_idx" ON "signup_requests" ("expires_at");
