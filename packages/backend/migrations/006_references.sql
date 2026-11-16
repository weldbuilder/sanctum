-- References: pictures the owner uploads so a generated picture can be OF someone or something specific.
-- Runs every boot like 001-005, so every statement is IF NOT EXISTS. The picture itself lives in the file store
-- (data/files, sidecar source 'reference'); file_id is its id there. Names are unique, compared without case.
-- self = 1 marks the companion's own look (used for selfies).
CREATE TABLE IF NOT EXISTS "references" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  file_id TEXT NOT NULL,
  self INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
