-- Restore the content column (for rollback purposes)
ALTER TABLE posts ADD COLUMN content TEXT NOT NULL DEFAULT '';
