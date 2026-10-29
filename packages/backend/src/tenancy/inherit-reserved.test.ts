// S3 (round 4): the reserved `inherit: false` key is stripped from the operator's file too, at every depth, so a tenant's loaded config never holds it and
// CONFIGURATION.md's "never in the loaded config" is true.
import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTenantConfig } from './config.js';
import { makeTenantsDir, processConfigFor } from './test-runtime.js';
import { inheritedBase, overlay } from '../../../../scripts/setup-inherit.mjs';

const has = (v: unknown): boolean => !!v && typeof v === 'object' && Object.entries(v as object).some(([k, x]) => k === 'inherit' || has(x));

describe('operator-side inherit: false', () => {
  const file = { inherit: false, agent: { inherit: false, model: 'operator-model', dsh: { inherit: false, sandbox: 'on' } }, tools: { inherit: false, web: true }, skins: [{ inherit: false, id: 'x' }] };
  it('inheritedBase carries no `inherit` key at any depth, and keeps every other value', () => {
    const base = inheritedBase(file);
    expect(has(base)).toBe(false);
    expect(base.agent.model).toBe('operator-model');
    expect(base.tools.web).toBe(true);
    expect(base.skins[0].id).toBe('x');
    expect(file.agent.inherit).toBe(false); // (the operator's own object is not changed)
  });
  it('the tenant\'s loaded config never holds it, with or without a tenant.yaml of its own', () => {
    for (const yamlText of [undefined, 'agent:\n  model: "ada-model"\n']) {
      const root = makeTenantsDir({ ada: yamlText === undefined ? {} : { yaml: yamlText } });
      const processCfg = processConfigFor(resolve(tmpdir(), 'sanctum-process'), { identity: { timezone: 'UTC' }, ...file });
      const c = loadTenantConfig(processCfg, join(root, 'ada'), 'ada', { processFile: file, quiet: true }).config;
      expect(has(c)).toBe(false);
      expect(c.agent.model).toBe(yamlText === undefined ? 'operator-model' : 'ada-model');
    }
  });
  it('a tenant.yaml\'s own `inherit: false` still replaces the inherited mapping (its meaning is unchanged)', () => {
    const merged = overlay(inheritedBase({ agent: { model: 'operator-model', provider: 'claude' } }), { agent: { inherit: false, model: 'own' } });
    expect(merged).toEqual({ agent: { model: 'own' } });
  });
});
