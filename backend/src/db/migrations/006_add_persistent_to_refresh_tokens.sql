ALTER TABLE refresh_tokens
  ADD COLUMN persistent BOOLEAN NOT NULL DEFAULT false;
