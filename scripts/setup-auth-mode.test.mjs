import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { terminalSetAuthMode } from './setup-auth-mode.mjs';

const made = [];
afterEach(() => { while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(tmpdir(), 'auth-mode-')); made.push(d); return d; };

describe('terminalSetAuthMode', () => {
  it('creates the data folder on a fresh clone', () => {
    const root = tmp();
    terminalSetAuthMode(root, {}, {})({ auth_mode: 'subscription' });
    expect(fs.existsSync(path.join(root, 'data', 'sanctum.db'))).toBe(true);
  }, 90000);

  it('writes to server.db_path from the loaded config, not data/sanctum.db', () => {
    const root = tmp();
    terminalSetAuthMode(root, {}, {})({ auth_mode: 'api_key', api_key: 'sk-test' }, { server: { db_path: './custom/app.db' } });
    expect(fs.existsSync(path.join(root, 'custom', 'app.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'sanctum.db'))).toBe(false);
  }, 90000);

  it('reports the Error line, not the Node version line', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'blocker'), 'x');
    expect(() => terminalSetAuthMode(root, {}, {})({ auth_mode: 'bogus' })).toThrow(/Error: auth_mode must be/);
  }, 90000);
});
