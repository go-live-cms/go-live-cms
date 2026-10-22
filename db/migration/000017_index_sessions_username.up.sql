-- #131: sessions by username and the ON UPDATE CASCADE from users.username.
CREATE INDEX CONCURRENTLY idx_sessions_username ON sessions (username);
