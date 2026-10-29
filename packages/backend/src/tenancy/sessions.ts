// The Claude Code transcripts of ONE tenant. The SDK's listSessions() reads process.env.CLAUDE_CONFIG_DIR (or ~/.claude), which in tenant mode is
// the process's store, and it takes no directory option for it; writing process.env per call would race between tenants. So in tenant mode the
// listing reads the tenant's own data/harness/claude/projects/<project>/<session>.jsonl directly, with the SDK's project-folder naming.
import { closeSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { ownOpenRead, ownReadable } from './own-files.js';
import { join } from 'node:path';

/** The SDK's project folder name: every character that is not a letter or digit becomes '-' (long names are cut and suffixed by the SDK; those are not found here). */
const projectDirName = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-');

function firstPrompt(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = ownOpenRead(file, { kind: 'file' }).fd; // (checked and opened in one step: a pipe swapped in after a check is refused, never waited on)
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const e = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (e.type !== 'user') continue;
        const c = e.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b: { type?: string }) => b?.type === 'text') as { text?: string } | undefined)?.text : undefined;
        if (text?.trim()) return text.trim().slice(0, 200);
      } catch { /* a partial last line */ }
    }
  } catch { /* unreadable: no title */ } finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

export interface TenantSession { sessionId: string; summary: string; lastModified: number; fileSize: number; firstPrompt?: string; cwd: string }

/** Sessions recorded under `configDir` for the project folder `cwd`, newest first. Missing folders list as empty. */
export function listTenantSessions(configDir: string, cwd: string, limit = 50): TenantSession[] {
  const names = new Set<string>([projectDirName(cwd)]);
  try { names.add(projectDirName(realpathSync.native(cwd))); } catch { /* the folder is not there yet */ }
  const out: TenantSession[] = [];
  for (const name of names) {
    const dir = join(configDir, 'projects', name);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      try {
        if (!ownReadable(join(dir, f), { kind: 'file' })) continue; // (a link planted among the harness's session files is not a session)
        const st = statSync(join(dir, f));
        const prompt = firstPrompt(join(dir, f));
        out.push({ sessionId: f.slice(0, -'.jsonl'.length), summary: prompt ?? f.slice(0, -'.jsonl'.length), lastModified: st.mtimeMs, fileSize: st.size, ...(prompt ? { firstPrompt: prompt } : {}), cwd });
      } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.lastModified - a.lastModified).slice(0, Math.max(1, limit));
}
