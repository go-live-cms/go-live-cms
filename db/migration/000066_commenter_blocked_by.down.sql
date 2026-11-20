ALTER TABLE commenters
  DROP CONSTRAINT commenters_blocked_by,
  DROP COLUMN blocked_by;
