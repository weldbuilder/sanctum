import { describe, it, expect } from 'vitest';
import { loadTenantInfo, parseTenant, tenantLine } from './tenantState';

describe('tenantLine', () => {
  it('shows nothing for null (a single-user install, or a 404)', () => {
    expect(tenantLine(null)).toBeNull();
  });
  it('says where the tenant is served and where its data is', () => {
    expect(tenantLine({ hosts: ['ada.example.net'], dir: '/srv/tenants/ada' })).toBe('Served at ada.example.net; data in /srv/tenants/ada');
    expect(tenantLine({ hosts: ['ada.example.net', 'ada2.example.net'], dir: '/t/ada' })).toBe('Served at ada.example.net, ada2.example.net; data in /t/ada');
  });
  it('a tenant with no hostname says only where its data is', () => {
    expect(tenantLine({ hosts: [], dir: '/t/ada' })).toBe('Data in /t/ada');
  });
});

describe('parseTenant', () => {
  it('accepts the answer and refuses anything else', () => {
    expect(parseTenant({ hosts: ['a.example.net'], dir: '/t/a' })).toEqual({ hosts: ['a.example.net'], dir: '/t/a' });
    for (const bad of [null, undefined, 'x', {}, { dir: '/t' }, { hosts: 'a', dir: '/t' }, { hosts: [1], dir: '/t' }, { hosts: [], dir: '' }]) expect(parseTenant(bad)).toBeNull();
  });
});

describe('loadTenantInfo', () => {
  const answer = (status: number, body: unknown) => (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
  it('reads the answer; a 404, a failure or a malformed body is null (no line)', async () => {
    expect(await loadTenantInfo('', answer(200, { hosts: ['a.example.net'], dir: '/t/a' }))).toEqual({ hosts: ['a.example.net'], dir: '/t/a' });
    expect(await loadTenantInfo('', answer(404, { error: 'not_found' }))).toBeNull();
    expect(await loadTenantInfo('', answer(200, { nope: true }))).toBeNull();
    expect(await loadTenantInfo('', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
});
