import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { requestHost, resolveTenant, setTenantRegistry, tenantResolve, tenantEnter } from './resolve.js';
import { currentTenant, enableTenancy } from './context.js';
import { fakeRuntime } from './test-runtime.js';

const ada = fakeRuntime('ada', { hosts: ['ada.example.net'] });
const bea = fakeRuntime('bea', { hosts: ['bea.example.net'] });

describe('requestHost', () => {
  it('uses Host, lower-cased, port stripped', () => {
    expect(requestHost({ host: 'Ada.Example.NET:3099' })).toBe('ada.example.net');
    expect(requestHost({ host: 'ada.example.net' })).toBe('ada.example.net');
  });
  it('keeps IPv6 brackets and drops the port after them', () => {
    expect(requestHost({ host: '[::1]:3099' })).toBe('[::1]');
    expect(requestHost({ host: '[2001:db8::1]' })).toBe('[2001:db8::1]');
  });
  it('takes the LAST X-Forwarded-Host entry: a spoofed first entry loses', () => {
    expect(requestHost({ host: 'internal:3099', 'x-forwarded-host': 'evil.example.net, ada.example.net' })).toBe('ada.example.net');
    expect(requestHost({ host: 'internal', 'x-forwarded-host': ['evil.example.net', 'bea.example.net:443'] })).toBe('bea.example.net');
    expect(requestHost({ host: 'internal', 'x-forwarded-host': 'ada.example.net' })).toBe('ada.example.net');
  });
  it('falls back to Host when the forwarded header is empty, and to empty when there is nothing', () => {
    expect(requestHost({ host: 'ada.example.net', 'x-forwarded-host': ' , ' })).toBe('ada.example.net');
    expect(requestHost({})).toBe('');
  });
});

describe('resolveTenant', () => {
  beforeEach(() => setTenantRegistry(new Map([['ada', ada], ['bea', bea]])));

  it('browser requests resolve by hostname only', () => {
    expect(resolveTenant({ host: 'ada.example.net' })?.id).toBe('ada');
    expect(resolveTenant({ host: 'bea.example.net', token: '' })?.id).toBe('bea');
  });
  it('an unclaimed host is a 404 without a default and the default with one', () => {
    expect(resolveTenant({ host: 'nobody.example.net' })).toBeNull();
    setTenantRegistry(new Map([['ada', ada], ['bea', bea]]), 'bea');
    expect(resolveTenant({ host: 'nobody.example.net' })?.id).toBe('bea');
    expect(resolveTenant({ host: '' })?.id).toBe('bea');
    expect(resolveTenant({ host: 'ada.example.net' })?.id).toBe('ada');
  });
  it('a token resolves by token, on an unclaimed host (loopback callers)', () => {
    expect(resolveTenant({ host: '127.0.0.1', token: 'token-ada' })?.id).toBe('ada');
    expect(resolveTenant({ host: '127.0.0.1', token: 'token-bea' })?.id).toBe('bea');
  });
  it('a token and a Host that names the same tenant agree', () => {
    expect(resolveTenant({ host: 'ada.example.net', token: 'token-ada' })?.id).toBe('ada');
  });
  it('a token and a Host naming a different tenant is a 404, both ways', () => {
    expect(resolveTenant({ host: 'bea.example.net', token: 'token-ada' })).toBeNull();
    expect(resolveTenant({ host: 'ada.example.net', token: 'token-bea' })).toBeNull();
  });
  it('an unknown token is a 404 even on a host that is claimed', () => {
    expect(resolveTenant({ host: 'ada.example.net', token: 'nope' })).toBeNull();
    expect(resolveTenant({ host: '127.0.0.1', token: 'nope' })).toBeNull();
  });
});

describe('middlewares', () => {
  const res = () => {
    const r = { code: 0, body: undefined as unknown, status(c: number) { r.code = c; return r; }, json(b: unknown) { r.body = b; return r; } };
    return r;
  };
  beforeEach(() => setTenantRegistry(new Map([['ada', ada], ['bea', bea]])));

  it('tenantResolve sets req.tenant from the trusted forwarded host, or answers 404', () => {
    const ok = { headers: { host: 'internal', 'x-forwarded-host': 'evil.example.net, ada.example.net' } } as unknown as Request;
    let called = 0;
    tenantResolve(ok, res() as unknown as Response, () => { called++; });
    expect(called).toBe(1);
    expect(ok.tenant?.id).toBe('ada');

    const miss = { headers: { host: 'nobody.example.net' } } as unknown as Request;
    const r = res();
    tenantResolve(miss, r as unknown as Response, () => { called++; });
    expect(called).toBe(1);
    expect(r.code).toBe(404);
    expect(miss.tenant).toBeUndefined();
  });

  it('tenantResolve reads the internal token header', () => {
    const req = { headers: { host: 'bea.example.net', 'x-internal-token': 'token-ada' } } as unknown as Request;
    const r = res();
    tenantResolve(req, r as unknown as Response, () => { throw new Error('should not pass'); });
    expect(r.code).toBe(404);
  });

  it('tenantEnter runs the rest of the chain inside the request tenant', async () => {
    enableTenancy(true);
    try {
      const req = { tenant: bea } as unknown as Request;
      let seen: string | undefined;
      await new Promise<void>((ok) => tenantEnter(req, {} as Response, () => { setTimeout(() => { seen = currentTenant()?.id; ok(); }, 1); }));
      expect(seen).toBe('bea');
      let passed = false;
      tenantEnter({} as Request, {} as Response, () => { passed = true; });
      expect(passed).toBe(true);
    } finally {
      enableTenancy(false);
    }
  });
});
