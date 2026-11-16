-- Stickers: small pictures the owner uploads and the companion sends with [sticker: name].
-- Runs every boot like 001-003, so every statement is IF NOT EXISTS. The picture itself lives in the file store
-- (data/files, sidecar source 'sticker'); file_id is its id there. Names are unique, compared without case.
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  file_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
