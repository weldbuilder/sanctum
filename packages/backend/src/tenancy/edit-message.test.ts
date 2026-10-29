import { describe, it, expect } from 'vitest';
import { TenantEditRefused } from './edit.js';
describe('TenantEditRefused message', () => {
  it('cuts absolute paths to their last segment and leaves ordinary slashes alone', () => {
    expect(new TenantEditRefused('timezone Pacific/Auckland differs; see docs/MULTI-TENANT.md').message).toBe('timezone Pacific/Auckland differs; see docs/MULTI-TENANT.md');
    expect(new TenantEditRefused('/srv/sanctum/ada/tenant.yaml is not a YAML map').message).toBe('tenant.yaml is not a YAML map');
    expect(new TenantEditRefused('agent.cwd /srv/sanctum/bea/home is outside').message).toBe('agent.cwd home is outside');
    expect(new TenantEditRefused('path C:\\srv\\ada\\tenant.yaml bad').message).toBe('path tenant.yaml bad');
  });
});
