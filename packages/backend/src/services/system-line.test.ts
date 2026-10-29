import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ created: [] as any[], throws: false }));
vi.mock('./db.js', () => ({
  createMessage: (m: any) => {
    if (h.throws) throw new Error('db is down');
    h.created.push(m);
    return { ...m, thread_id: m.threadId, created_at: m.createdAt };
  },
}));

import { postSystemLine, setSystemLineRegistry } from './system-line.js';
import { isSpokenTurn } from './rolling-context.js';

const sent: any[] = [];
const reg = { broadcast: (m: any) => { sent.push(m); } };

beforeEach(() => { h.created = []; h.throws = false; sent.length = 0; setSystemLineRegistry(null); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('postSystemLine', () => {
  it('saves a role-system message with the kind in its metadata and pushes it to the apps', () => {
    setSystemLineRegistry(reg);
    expect(postSystemLine('t1', 'Identity change waiting', 'identity_pending', { identityDigest: 'd' })).toBe(true);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ threadId: 't1', role: 'system', content: 'Identity change waiting', contentType: 'text', platform: 'web', metadata: { identityDigest: 'd', kind: 'identity_pending' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'message', message: { content: 'Identity change waiting' } });
  });

  it('Discord keeps its own platform and registry, and its lines stay out of the history', () => {
    const own: any[] = [];
    postSystemLine('t1', 'a reply was withheld', 'withheld', { discordWithheld: true }, { platform: 'discord', registry: { broadcast: (m) => own.push(m) } });
    expect(h.created[0]).toMatchObject({ platform: 'discord', metadata: { discordWithheld: true, kind: 'withheld' } });
    expect(own).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(isSpokenTurn({ role: 'system', platform: 'discord', metadata: h.created[0].metadata })).toBe(false);
  });

  it('never throws: a database failure is false and nothing is pushed', () => {
    setSystemLineRegistry(reg);
    h.throws = true;
    expect(postSystemLine('t1', 'x', 'discord_notice')).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('with no registry the line is saved and nothing is pushed', () => {
    expect(postSystemLine('t1', 'x', 'identity_pending')).toBe(true);
    expect(h.created).toHaveLength(1);
  });
});
