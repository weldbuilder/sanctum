// Outside household mode the URL helpers are the identity (single-tenant and per-tenant answers stay byte-identical to main).
import { describe, it, expect } from 'vitest';
import { companionPath, plainPath, householdMode } from './house.js';
import { runInTenant } from './context.js';
import { fakeRuntime } from './test-runtime.js';

describe('companionPath with household mode off', () => {
  it('returns every path unchanged, with or without a tenant in scope', () => {
    expect(householdMode()).toBe(false);
    expect(companionPath('/api/files/x')).toBe('/api/files/x');
    expect(companionPath('/chat')).toBe('/chat');
    runInTenant(fakeRuntime('ada'), () => {
      expect(companionPath('/api/files/x')).toBe('/api/files/x');
      expect(plainPath('/c/ada/api/files/x')).toBe('/c/ada/api/files/x');
    });
  });
});
