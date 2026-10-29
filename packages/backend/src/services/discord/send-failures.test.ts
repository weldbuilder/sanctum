// D11: a gate that cannot run is a failure the person must be able to see: it goes to the logs service under the
// discord category (kind only), not just back to the caller as a block.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./paths.js', () => ({ getDiscordPaths: () => ({ privateDir: '', wordsFile: '/nonexistent/words.txt', namesFile: '', exclusionsFile: '', refused: [] }) }));
vi.mock('../../config.js', () => ({ getSanctumConfig: () => ({ discord: { paused: false, public: { enabled: true } } }) }));

import { sendGated } from './send.js';
import { eventSummary, resetEvents } from '../logs.js';

beforeEach(() => { resetEvents(); });

describe('sendGated: gate errors reach the logs service', () => {
  it('a missing word list blocks the send AND records gate_error under discord, with no path in the line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sendGated({ kind: 'reply', message: { reply: async () => ({}), channel: {} } }, 'hello', 'owner');
    expect(r).toMatchObject({ sent: false, reason: 'gate_error' });
    expect(eventSummary('discord')).toMatchObject({ count24h: 1, lastKind: 'gate_error' });
    expect(err.mock.calls.flat().join('\n')).toContain('[discord] failure kind=gate_error');
    expect(err.mock.calls.flat().join('\n')).not.toContain('/nonexistent');
    warn.mockRestore(); err.mockRestore();
  });
});
