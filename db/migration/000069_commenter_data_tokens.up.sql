-- A commenter's data link (#529, docs/design/reader-comments.md 13.2, 9.2): "Your
-- comments". A reader types their address on /comments/your-data and, if comments were
-- written with it, gets a link (PUBLIC_BASE_URL/comments/your-data#token=…) that lists,
-- downloads and deletes them. Only the token's SHA-256 is kept. The link works for an
-- hour and isn't spent by reading the list or deleting one comment (the page does
-- several of those with one link); erasing the commenter deletes it with everything
-- else (ON DELETE CASCADE). RunDiscussionMaintenance deletes expired ones.
BEGIN;

CREATE TABLE commenter_data_tokens (
  token_hash   bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  commenter_id bigint NOT NULL REFERENCES commenters (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX commenter_data_tokens_commenter ON commenter_data_tokens (commenter_id);
CREATE INDEX commenter_data_tokens_expires ON commenter_data_tokens (expires_at);

COMMIT;
