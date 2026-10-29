#!/usr/bin/env node
/**
 * One-off, WAL-safe setup of FTS5 full-text search over messages.content.
 *
 * Creates a STANDALONE FTS5 table (messages_fts) with an UNINDEXED message_id
 * column — the robust choice because messages.id is TEXT, not an integer rowid,
 * so we cannot use a contentless/external-content rowid-linked FTS table.
 *
 * Adds AFTER INSERT/UPDATE/DELETE triggers on `messages` so the index stays
 * synced for all future live writes (they persist at the DB level), then
 * backfills the index from every existing non-deleted message (incl. the
 * just-imported archive).
 *
 * Idempotent: re-running is safe (IF NOT EXISTS, DROP+CREATE triggers,
 * backfill only inserts rows not already indexed).
 *
 * Usage: node scripts/setup-fts.mjs
 */

import Database from 'better-sqlite3';

const TARGET_PATH = process.env.DB_PATH || './data/sanctum.db';

const db = new Database(TARGET_PATH);
db.pragma('busy_timeout = 10000');

try {
  // Confirm FTS5 is available before we touch anything.
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS __fts_probe');
  } catch (e) {
    console.error('[setup-fts] FTS5 not available in this SQLite build:', e.message);
    process.exit(1);
  }

  // 1. FTS5 virtual table. message_id UNINDEXED (stored, not tokenized).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      message_id UNINDEXED,
      tokenize = 'porter unicode61'
    )
  `);

  // 2. Triggers keep FTS synced with messages. Keyed on message_id (TEXT).
  //    We do not index tombstoned content: INSERT only indexes live rows,
  //    UPDATE refreshes (and drops if newly deleted), DELETE removes.
  db.exec(`DROP TRIGGER IF EXISTS messages_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS messages_fts_au`);
  db.exec(`DROP TRIGGER IF EXISTS messages_fts_ad`);

  db.exec(`
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
    WHEN new.deleted_at IS NULL
    BEGIN
      INSERT INTO messages_fts (content, message_id) VALUES (new.content, new.id);
    END
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts (content, message_id)
        SELECT new.content, new.id WHERE new.deleted_at IS NULL;
    END
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END
  `);

  // 3. Backfill: index every live message not already present.
  const totalLive = db.prepare('SELECT COUNT(*) c FROM messages WHERE deleted_at IS NULL').get().c;
  const before = db.prepare('SELECT COUNT(*) c FROM messages_fts').get().c;

  const insert = db.prepare(`
    INSERT INTO messages_fts (content, message_id)
    SELECT m.content, m.id
    FROM messages m
    WHERE m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.message_id = m.id)
  `);
  const r = db.transaction(() => insert.run())();

  const after = db.prepare('SELECT COUNT(*) c FROM messages_fts').get().c;

  console.log('[setup-fts] FTS5 table + triggers ready.');
  console.log('  live messages (deleted_at IS NULL):', totalLive);
  console.log('  messages_fts rows before:', before, '-> after:', after, `(+${r.changes})`);

  // 4. Sanity MATCH for a common word, joined to thread names.
  const sample = db.prepare(`
    SELECT f.message_id, m.role, t.name AS thread_name,
           substr(m.content,1,60) AS preview
    FROM messages_fts f
    JOIN messages m ON m.id = f.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE messages_fts MATCH ?
      AND m.deleted_at IS NULL
    LIMIT 3
  `).all('the');
  console.log('  sample MATCH "the" (3 rows):');
  for (const s of sample) {
    console.log('    -', { thread: s.thread_name, role: s.role, preview: String(s.preview).replace(/\s+/g, ' ') });
  }
} finally {
  db.close();
}
