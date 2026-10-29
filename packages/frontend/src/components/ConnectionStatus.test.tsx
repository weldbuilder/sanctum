import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionStatus } from './ConnectionStatus';
import type { IdentityStatus } from './settings/identityState';

const D = 'a'.repeat(64);
const id = (state: IdentityStatus['state']): IdentityStatus => ({ state, digest: D, ratified: null, pending: null, files: [], skipped: [], detail: null, checkedAt: 'x' });
const html = (props: Partial<Parameters<typeof ConnectionStatus>[0]>) => renderToStaticMarkup(<ConnectionStatus state="connected" error={null} pendingCount={0} {...props} />);

describe('ConnectionStatus: the identity notice', () => {
  it('is silent when identity is ratified or there is no reading', () => {
    expect(html({ identity: id('ok') })).toBe('');
    expect(html({ identity: null })).toBe('');
  });
  it('says "Identity change waiting" and "Identity not yet ratified" as a quiet line, not an error', () => {
    const waiting = html({ identity: id('pending') });
    expect(waiting).toContain('Identity change waiting');
    expect(waiting).toContain('connection-banner mind');
    expect(waiting).not.toContain('connection-banner error');
    expect(html({ identity: id('unratified') })).toContain('Identity not yet ratified');
  });
  it('rides under a real connection problem rather than replacing it', () => {
    const out = html({ state: 'disconnected', identity: id('pending') });
    expect(out).toContain('disconnected');
    expect(out).toContain('Identity change waiting');
    expect(out).toContain('connection-banner disconnected');
  });
  it('shares the line with the Mind notice', () => {
    const out = html({ identity: id('pending'), mind: { state: 'offline', checkedAt: 'x', latencyMs: null } });
    expect(out).toContain('Identity change waiting · Mind offline');
  });
});
