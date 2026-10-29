// The public lane's record (docs/DISCORD-PLAN.md, "Records"): every public message in, every reply out,
// every blocked reply and every failed run, with who and where, one JSONL file per channel:
//
//   <data>/discord/public/<guildId>/<channelId>.jsonl      <data> = the folder holding the Sanctum database
//
// One line per event: { ts, kind: in | out | blocked | error, who: {id, name, bot}, where: {guild, channel,
// thread?}, text?, hits?, reason?, len }. `blocked` and `error` lines never carry text: only the reason,
// the matched list entries and the length. The file is append-only, 0600, in folders made 0700.
//
// Nothing from it becomes memory on its own: no module outside services/discord imports this one, and
// a test greps for it. The companion reads the last few lines of THIS channel only, through tail(),
// for the frame of the next public turn.

import { closeSync, readSync } from 'node:fs';
import { ownAppendFile, ownChmod, ownMkdir, ownOpenRead } from '../../tenancy/own-files.js';
import { dirname, join } from 'node:path';
import { getSanctumConfig } from '../../config.js';

export type TranscriptKind = 'in' | 'out' | 'blocked' | 'error';

export interface TranscriptWho { id: string; name: string; bot: boolean }
export interface TranscriptWhere { guild: string; channel: string; thread?: string }

export interface TranscriptEntry {
  kind: TranscriptKind;
  who: TranscriptWho;
  where: TranscriptWhere;
  /** in and out only. Dropped from blocked and error lines, whatever the caller passes. */
  text?: string;
  /** blocked: the list entries that matched (never the text). */
  hits?: string[];
  /** blocked: why (word, name, paused, ...). error: the error class. */
  reason?: string;
  len: number;
  /** in only: how many attachments the message had (present, never opened). */
  attachments?: number;
}

export interface TranscriptLine extends TranscriptEntry { ts: string }

/** Discord ids are digits. Anything else never reaches a path. */
const ID = /^\d{1,25}$/;
const TAIL_BYTES = 256 * 1024;

export interface Transcript {
  append(entry: TranscriptEntry): void;
  /** The last `n` in and out lines of one PLACE, oldest first: with `threadId`, only the lines whose where.thread is
   *  that thread; without it, only the lines of the channel itself (no thread). Never throws: a missing file, a bad id
   *  or a damaged line gives what can be read. */
  tail(guildId: string, channelId: string, n: number, threadId?: string): TranscriptLine[];
  file(guildId: string, channelId: string): string;
}

export function createTranscript(root: () => string, now: () => Date = () => new Date()): Transcript {
  const fileFor = (guildId: string, channelId: string): string => {
    if (!ID.test(guildId) || !ID.test(channelId)) throw new Error('a transcript needs numeric guild and channel ids');
    return join(root(), guildId, channelId + '.jsonl');
  };

  const ensureDir = (guildDir: string) => {
    // Every folder this makes is owner-only, whatever the umask said.
    ownMkdir(guildDir, { recursive: true, mode: 0o700 });
    for (const d of [root(), guildDir]) {
      try { ownChmod(d, 0o700); } catch { /* not ours to change */ }
    }
  };

  return {
    file: fileFor,

    append(entry) {
      const file = fileFor(entry.where.guild, entry.where.channel);
      const carriesText = entry.kind === 'in' || entry.kind === 'out';
      const line: TranscriptLine = {
        ts: now().toISOString(),
        kind: entry.kind,
        who: entry.who,
        where: entry.where,
        ...(carriesText && entry.text !== undefined ? { text: entry.text } : {}),
        ...(entry.hits ? { hits: entry.hits } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.kind === 'in' && entry.attachments ? { attachments: entry.attachments } : {}),
        len: carriesText && entry.text !== undefined ? entry.text.length : entry.len,
      };
      ensureDir(dirname(file));
      ownAppendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 });
      try { ownChmod(file, 0o600); } catch { /* not ours to change */ }
    },

    tail(guildId, channelId, n, threadId) {
      let file: string;
      try { file = fileFor(guildId, channelId); } catch { return []; }
      if (threadId !== undefined && !ID.test(threadId)) return [];
      let text = '';
      try {
        const { fd, stat } = ownOpenRead(file, { kind: 'file' }); // (a tenant: never a link, a second hard link or a pipe: one guarded open, no check before a plain open)
        try {
          const size = stat.size;
          const start = Math.max(0, size - TAIL_BYTES);
          const buf = Buffer.alloc(size - start);
          readSync(fd, buf, 0, buf.length, start);
          text = buf.toString('utf-8');
          if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line may be cut
        } finally { closeSync(fd); }
      } catch { return []; }
      const out: TranscriptLine[] = [];
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        try {
          const l = JSON.parse(raw) as TranscriptLine;
          if (!((l.kind === 'in' || l.kind === 'out') && typeof l.text === 'string')) continue;
          const lineThread = l.where?.thread;
          if (threadId === undefined ? lineThread !== undefined : lineThread !== threadId) continue; // this place only
          out.push(l);
        } catch { /* a damaged line is skipped */ }
      }
      return n > 0 ? out.slice(-n) : [];
    },
  };
}

/** <data>/discord/public: beside the Sanctum database, never inside the companion's home. */
export function publicTranscriptRoot(): string {
  return join(dirname(getSanctumConfig().server.db_path), 'discord', 'public');
}

/** The app's transcript. */
export const publicTranscript: Transcript = createTranscript(publicTranscriptRoot);
