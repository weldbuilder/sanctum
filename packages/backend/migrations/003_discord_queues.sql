-- Discord queues that must survive a restart (docs/DISCORD-PLAN.md, D5 and D1).
-- Runs every boot like 001 and 002, so every statement is IF NOT EXISTS.
--
-- A queued batch is written down as ids and labels, never as message text: the messages are fetched from Discord
-- again when the gateway starts. `who` and `msg_count` are what the expiry line needs ("2 from Moss (@moss)") when
-- the messages cannot be fetched any more.

-- Non-owner batches held while the owner is active on the web (the deferral queue). Expiry runs on queued_at.
CREATE TABLE IF NOT EXISTS discord_deferrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  user_id TEXT NOT NULL,
  message_ids TEXT NOT NULL,       -- JSON array of message ids, oldest first
  who TEXT NOT NULL DEFAULT '',
  msg_count INTEGER NOT NULL DEFAULT 1,
  queued_at INTEGER NOT NULL       -- epoch ms
);

-- Batches waiting behind a running one (the sending buffer). queue_key is (lane, channel, user), or the channel on
-- the owner lane; rows of one key keep their order by id.
CREATE TABLE IF NOT EXISTS discord_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_key TEXT NOT NULL,
  lane TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  user_id TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  who TEXT NOT NULL DEFAULT '',
  msg_count INTEGER NOT NULL DEFAULT 1
);

-- Bot exchange counters: her replies per (channel, bot) since a human last spoke in the channel...
CREATE TABLE IF NOT EXISTS discord_bot_exchanges (
  channel_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (channel_id, bot_id)
);

-- ...and the times of her replies to bots, for the hourly total.
CREATE TABLE IF NOT EXISTS discord_bot_replies (
  at INTEGER NOT NULL              -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_discord_bot_replies_at ON discord_bot_replies(at);

-- How many restores have failed to fetch a queued row's messages (a transient Discord failure at boot keeps the row;
-- after 3 the row is dropped with an owner line). Keyed by the queue and the row's message ids.
CREATE TABLE IF NOT EXISTS discord_restore_attempts (
  queue TEXT NOT NULL,             -- 'deferral' | 'followup'
  message_ids TEXT NOT NULL,       -- the row's JSON array of message ids
  attempts INTEGER NOT NULL,
  PRIMARY KEY (queue, message_ids)
);

-- Hourglasses (U+23F3) that could not be taken off a message because Discord could not be reached: the next start
-- takes them off. attempts bounds the retries.
CREATE TABLE IF NOT EXISTS discord_pending_unreact (
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, message_id)
);
