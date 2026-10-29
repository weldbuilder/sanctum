// Round 6, item 7: one scan of the tenant folder per request. withScanMemo answers a repeated scan inside one synchronous call chain from the first walk
// (and forgets at the end); the wizard's own run makes ONE full scan (the walk's early look is the quick form), applySetup's pre-write check and its dry run
// sharing it. The /apply route has the same counter test in packages/backend/src/tenancy/setup-tenant.test.ts. No provider, no model run.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { runSetup } from './setup-walk.mjs';
import { scanStats, tenantFilesProblem, withScanMemo } from './own-files-lib.mjs';

function folder() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'scan-once-')));
  for (const d of ['home', 'data', 'private']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

describe('withScanMemo', () => {
  it('answers the same scan again from the first walk, per kind of scan, and forgets when the call ends', () => {
    const dir = folder();
    try {
      const before = { ...scanStats };
      withScanMemo(() => {
        expect(tenantFilesProblem(dir)).toBe('');
        expect(tenantFilesProblem(dir)).toBe('');
        expect(tenantFilesProblem(dir, { quick: true })).toBe('');
        expect(tenantFilesProblem(dir, { quick: true })).toBe('');
        withScanMemo(() => { expect(tenantFilesProblem(dir)).toBe(''); }); // (nested: the outer memo)
      });
      expect(scanStats.full - before.full).toBe(1);
      expect(scanStats.quick - before.quick).toBe(1);
      tenantFilesProblem(dir); // (outside: a fresh walk)
      expect(scanStats.full - before.full).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not outlive a throw', () => {
    const dir = folder();
    try {
      expect(() => withScanMemo(() => { tenantFilesProblem(dir); throw new Error('x'); })).toThrow('x');
      const before = scanStats.full;
      tenantFilesProblem(dir);
      expect(scanStats.full - before).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the wizard scans the tenant folder once (fully)', () => {
  it('npm run setup -- --tenant: one full scan for the whole run (plus the walk\'s quick look)', async () => {
    const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'scan-once-wiz-')));
    try {
      const app = path.join(sbx, 'app');
      fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
      appFixture(fs, path, app);
      const tenants = path.join(app, 'tenants');
      fs.mkdirSync(path.join(tenants, 'ada', 'home', 'identity'), { recursive: true });
      fs.writeFileSync(path.join(tenants, 'ada', 'home', 'identity', 'profile.md'), 'p\n');
      fs.writeFileSync(path.join(app, 'sanctum.yaml'), `identity:\n  timezone: "UTC"\nagent:\n  provider: "claude"\ntenants:\n  dir: ${JSON.stringify(tenants)}\n`);
      const answers = [['Which one?', '2'], ['Anthropic API key', 'sk-ant-x'], ['App password', 'a-tenant-pass']];
      const io = {
        say: () => {},
        prompt: async (text) => { const hit = answers.length && text.includes(answers[0][0]) ? answers.shift()[1] : ''; return hit; },
      };
      const before = { ...scanStats };
      await runSetup({ root: app, io, processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: false, tenant: 'ada' });
      expect(fs.existsSync(path.join(tenants, 'ada', 'tenant.yaml'))).toBe(true);
      expect(scanStats.full - before.full).toBe(1);
      expect(scanStats.quick - before.quick).toBe(1);
    } finally { fs.rmSync(sbx, { recursive: true, force: true }); }
  });
});
