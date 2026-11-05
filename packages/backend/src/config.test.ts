import { describe, it, expect, vi } from 'vitest';
import { resolve as pathResolve, join as pathJoin, dirname as pathDirname } from 'node:path';
import { normalizeDiscordConfig, contextWindowTag, resolveAutonomousModel, applyLegacyRolling, resolveDbPath, CONFIG_FILE_NAMES, isLoopbackHost, internalBaseUrl, boundOrigin, browserFrameOrigin, checkBrowserUrl, resolveBrowserUrlUpdate } from './config.js';

describe('contextWindowTag', () => {
  it('reads the bracketed tag at the end of a model id', () => {
    expect(contextWindowTag('claude-opus-4-8[1m]')).toBe('1m');
    expect(contextWindowTag('claude-opus-4-8[1M]')).toBe('1m');
    expect(contextWindowTag('claude-sonnet-4-6')).toBe('');
    expect(contextWindowTag('')).toBe('');
  });
});

describe('resolveAutonomousModel', () => {
  it('follows the chat model when model_autonomous is empty or unset', () => {
    const warn = vi.fn();
    expect(resolveAutonomousModel('claude-opus-4-8[1m]', '', warn)).toBe('claude-opus-4-8[1m]');
    expect(resolveAutonomousModel('claude-opus-4-8[1m]', undefined, warn)).toBe('claude-opus-4-8[1m]');
    expect(resolveAutonomousModel('claude-opus-4-8[1m]', '   ', warn)).toBe('claude-opus-4-8[1m]');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an explicit model_autonomous and stays quiet when the windows match', () => {
    const warn = vi.fn();
    expect(resolveAutonomousModel('claude-opus-4-8[1m]', 'claude-sonnet-5[1m]', warn)).toBe('claude-sonnet-5[1m]');
    expect(resolveAutonomousModel('claude-opus-4-8', 'claude-haiku-4-5', warn)).toBe('claude-haiku-4-5');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when chat and wakes would run on different context windows', () => {
    const warn = vi.fn();
    // The original miss: [1m] on agent.model, the shipped default left on model_autonomous.
    expect(resolveAutonomousModel('claude-opus-4-8[1m]', 'claude-sonnet-4-6', warn)).toBe('claude-sonnet-4-6');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/different context window/);
  });
});

describe('applyLegacyRolling', () => {
  const base = () => ({ agent: { codex: { rolling: { enabled: false, tail_chars: 9000, model: 'tiny' } }, rolling: { claude: true, codex: true, tail_chars: 14000, model: '' } } }) as any;
  it('folds a legacy agent.codex.rolling block into agent.rolling and removes it', () => {
    const m = base();
    applyLegacyRolling(m, {});
    expect(m.agent.rolling).toMatchObject({ claude: true, codex: false, tail_chars: 9000, model: 'tiny' });
    expect(m.agent.codex.rolling).toBeUndefined();
  });
  it('an explicit new key wins over the legacy one', () => {
    const m = base();
    applyLegacyRolling(m, { rolling: { codex: true, tail_chars: 14000 } });
    expect(m.agent.rolling).toMatchObject({ codex: true, tail_chars: 14000, model: 'tiny' });
  });
  it('does nothing without a legacy block', () => {
    const m = { agent: { codex: {}, rolling: { claude: true, codex: true } } } as any;
    applyLegacyRolling(m, undefined);
    expect(m.agent.rolling).toEqual({ claude: true, codex: true });
  });
});

describe('rename fallbacks', () => {
  it('reads sanctum.yaml first and a resonant.yaml from before the rename after it', () => {
    expect(CONFIG_FILE_NAMES[0]).toBe('sanctum.yaml');
    expect(CONFIG_FILE_NAMES.indexOf('resonant.yaml')).toBeGreaterThan(CONFIG_FILE_NAMES.indexOf('config/sanctum.yaml'));
  });
  it('keeps an existing resonant.db when sanctum.db does not exist yet, unless the path was set explicitly', () => {
    const only = (name: string) => (p: string) => p.endsWith(name);
    expect(resolveDbPath('/x/data/sanctum.db', false, only('resonant.db'))).toBe('/x/data/resonant.db');
    expect(resolveDbPath('/x/data/sanctum.db', false, only('sanctum.db'))).toBe('/x/data/sanctum.db');
    expect(resolveDbPath('/x/data/sanctum.db', false, () => false)).toBe('/x/data/sanctum.db');
    expect(resolveDbPath('/x/data/sanctum.db', true, only('resonant.db'))).toBe('/x/data/sanctum.db');
    expect(resolveDbPath('/x/custom/mine.db', false, () => true)).toBe('/x/custom/mine.db');
  });
});

describe('host helpers', () => {
  it('treats loopback and the unspecified address as loopback', () => {
    for (const h of ['', 'localhost', '127.0.0.1', '::1', '0.0.0.0', '::', ' LOCALHOST ']) expect(isLoopbackHost(h)).toBe(true);
    expect(isLoopbackHost('100.64.0.1')).toBe(false);
    expect(isLoopbackHost('box.tailnet.ts.net')).toBe(false);
  });
  it('points the built-in tools at the bound address, loopback otherwise', () => {
    expect(internalBaseUrl({ host: '127.0.0.1', port: 3099 })).toBe('http://127.0.0.1:3099');
    expect(internalBaseUrl({ host: '0.0.0.0', port: 3099 })).toBe('http://127.0.0.1:3099');
    // The server does not listen on loopback at all here; loopback would fail.
    expect(internalBaseUrl({ host: '100.64.0.1', port: 3099 })).toBe('http://100.64.0.1:3099');
    expect(internalBaseUrl({ host: 'fd7a::1', port: 3099 })).toBe('http://[fd7a::1]:3099');
  });
  it('allows the bound address as a browser origin only when it is not loopback', () => {
    expect(boundOrigin({ host: '127.0.0.1', port: 3099 })).toBe('');
    expect(boundOrigin({ host: '0.0.0.0', port: 3099 })).toBe('');
    expect(boundOrigin({ host: '100.64.0.1', port: 3099 })).toBe('http://100.64.0.1:3099');
  });
});

describe('browserFrameOrigin', () => {
  it('returns only the origin of an http(s) viewer URL', () => {
    expect(browserFrameOrigin('http://viewer.example:6080/vnc.html?autoconnect=1&resize=scale')).toBe('http://viewer.example:6080');
    expect(browserFrameOrigin(' https://viewer.example/path ')).toBe('https://viewer.example');
  });

  it('returns empty for unset, malformed, or non-http(s) values', () => {
    expect(browserFrameOrigin('')).toBe('');
    expect(browserFrameOrigin(undefined)).toBe('');
    expect(browserFrameOrigin('not a url')).toBe('');
    expect(browserFrameOrigin('javascript:alert(1)')).toBe('');
    expect(browserFrameOrigin('file:///etc/passwd')).toBe('');
  });
});

describe('checkBrowserUrl (CSP-safe host allowlist)', () => {
  it('accepts plain hosts, IPv4, bracketed IPv6, ports, and paths', () => {
    for (const u of [
      'http://127.0.0.1:3000/',
      'https://viewer.example',
      'http://my-host.example.net:6080/vnc.html?autoconnect=1&resize=scale',
      'http://[::1]:3000/',
      'http://[fd7a:115c:a1e0::1]:3000/',
    ]) expect(checkBrowserUrl(u).ok, u).toBe(true);
  });

  it('rejects hosts that would break or widen the CSP header', () => {
    for (const u of [
      'http://a,b.example/',          // crashed helmet on restart
      'http://*/',
      'http://*.example/',
      'http://%2a.example/',
      'http://a;b.example/',
      "http://a'b.example/",
      'http://user:pass@host.example/',
      'http://user@host.example/',
      'http://host.example:99999/',
      'http://host.example:0/',
      'http://-bad.example/',
      'http://bad..example/',
      'http://host.example/ x',
      'ftp://host.example/',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) expect(checkBrowserUrl(u).ok, u).toBe(false);
  });

  it('rejects values over 2048 characters', () => {
    expect(checkBrowserUrl('http://host.example/' + 'a'.repeat(2048)).ok).toBe(false);
  });

  it('never yields a frame origin containing header-breaking characters', () => {
    for (const u of ['http://a,b.example/', 'http://*/', 'http://*.example/', 'http://u:p@h.example/']) {
      expect(browserFrameOrigin(u)).toBe('');
    }
    expect(browserFrameOrigin('http://viewer.example:80/x')).toBe('http://viewer.example');
  });
});

describe('resolveBrowserUrlUpdate', () => {
  it('saves a valid value and clears on empty', () => {
    expect(resolveBrowserUrlUpdate(' http://h.example:3000/ ', '')).toEqual({ action: 'set', value: 'http://h.example:3000/' });
    expect(resolveBrowserUrlUpdate('', 'http://a,b/')).toEqual({ action: 'set', value: '' });
  });

  it('rejects a new invalid value', () => {
    expect(resolveBrowserUrlUpdate('http://a,b.example/', '').action).toBe('reject');
  });

  it('keeps an unchanged invalid saved value instead of blocking the save', () => {
    expect(resolveBrowserUrlUpdate('http://a,b.example/', 'http://a,b.example/')).toEqual({ action: 'keep' });
  });
});

describe('checkBrowserUrl: non-string YAML values', () => {
  it('rejects numbers, booleans, lists and maps without throwing', () => {
    for (const v of [8080, true, false, ['http://h.example/'], { url: 'http://h.example/' }, 0]) {
      expect(() => checkBrowserUrl(v)).not.toThrow();
      expect(checkBrowserUrl(v).ok, JSON.stringify(v)).toBe(false);
      expect(browserFrameOrigin(v)).toBe('');
    }
    expect(checkBrowserUrl(null).ok).toBe(false);
    expect(checkBrowserUrl(undefined).ok).toBe(false);
  });

  it('resolveBrowserUrlUpdate tolerates a non-string saved value', () => {
    expect(resolveBrowserUrlUpdate('http://a,b/', 8080).action).toBe('reject');
    expect(resolveBrowserUrlUpdate('http://h.example/', ['x'])).toEqual({ action: 'set', value: 'http://h.example/' });
  });
});

describe('checkBrowserUrl: scheme case', () => {
  it('accepts an uppercase scheme and host, with a lowercase origin', () => {
    const r = checkBrowserUrl('HTTP://LocalHost:3000/x');
    expect(r.ok).toBe(true);
    expect(browserFrameOrigin('HTTP://LocalHost:3000/x')).toBe('http://localhost:3000');
    expect(checkBrowserUrl('HTTPS://Viewer.Example/').ok).toBe(true);
  });
});

describe('checkBrowserUrl: refuses the app itself', () => {
  const self = { host: '127.0.0.1', port: 3099 };
  it('rejects the app origin under loopback aliases and the configured host', () => {
    for (const u of ['http://127.0.0.1:3099/', 'http://localhost:3099/x', 'http://[::1]:3099/', 'http://127.0.0.2:3099/', 'HTTP://LOCALHOST:3099/']) {
      expect(checkBrowserUrl(u, self).ok, u).toBe(false);
    }
    expect(checkBrowserUrl('http://box.example:3099/', { host: 'box.example', port: 3099 }).ok).toBe(false);
    expect(browserFrameOrigin('http://localhost:3099/', self)).toBe('');
  });
  it('allows other ports and other hosts', () => {
    expect(checkBrowserUrl('http://127.0.0.1:3000/', self).ok).toBe(true);
    expect(checkBrowserUrl('http://viewer.example:3099/', self).ok).toBe(true);
  });
  it('applies on update too', () => {
    expect(resolveBrowserUrlUpdate('http://localhost:3099/', '', self).action).toBe('reject');
  });
});

describe('plugins block (BLOCKER A)', () => {
  const load = async (yamlText?: string) => {
    vi.resetModules();
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sanctum-cfg-'));
    const file = join(dir, 'sanctum.yaml');
    if (yamlText !== undefined) writeFileSync(file, yamlText);
    const m = await import('./config.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return { cfg: m.loadConfig(file), root: m.PROJECT_ROOT };
  };
  it('defaults to dir "" (no person root, NOT <agent.cwd>/plugins) and enabled []', async () => {
    const { join } = await import('node:path');
    const { cfg, root } = await load('agent:\n  cwd: "/some/home"\n');
    expect(cfg.plugins).toEqual({ dir: '', ledger_dir: join(root, 'data', 'plugins'), enabled: [], trust: 'companion' });
    expect((cfg as any).plugins_dir).toBeUndefined();
  });
  it('plugins.ledger_dir: default <project>/data/plugins; a relative value resolves against the project root; ~ expands', async () => {
    const { resolve, join } = await import('node:path');
    const { homedir } = await import('node:os');
    const a = await load('plugins:\n  ledger_dir: "../ledger-away"\n');
    expect(a.cfg.plugins.ledger_dir).toBe(resolve(a.root, '../ledger-away'));
    const b = await load('plugins:\n  ledger_dir: "~/ledger"\n');
    expect(b.cfg.plugins.ledger_dir).toBe(join(homedir(), 'ledger'));
    const c = await load('plugins:\n  ledger_dir: "  "\n');
    expect(c.cfg.plugins.ledger_dir).toBe(join(c.root, 'data', 'plugins'));
  });
  it('identity.ledger_dir: "" is <project>/data/identity whatever db_path says, and the docs say the same', async () => {
    const { join } = await import('node:path');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const a = await load('server:\n  db_path: "/somewhere/else/sanctum.db"\n');
    expect(a.cfg.identity.ledger_dir).toBe(join(a.root, 'data', 'identity'));
    const docs = readFileSync(fileURLToPath(new URL('../../../docs/CONFIGURATION.md', import.meta.url)), 'utf-8');
    const row = docs.split('\n').find((l) => l.startsWith('| `ledger_dir` | `""` | Where the identity ledger lives')) ?? '';
    expect(row).toContain('`<project>/data/identity`');
    expect(row).toContain('regardless of `server.db_path`');
    expect(row).not.toContain('beside the database');
    expect(docs).toContain('longer than 120 characters');
  });
  it('resolves a relative dir against the project root and keeps the enabled ids, dropping junk', async () => {
    const { resolve } = await import('node:path');
    const { cfg, root } = await load('plugins:\n  dir: "../my-plugins"\n  enabled: ["hello", 3, ""]\n');
    expect(cfg.plugins.dir).toBe(resolve(root, '../my-plugins'));
    expect(cfg.plugins.enabled).toEqual(['hello']);
  });
  it('plugins.trust: companion by default, person when asked, an unknown value warns and means companion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await load('plugins:\n  trust: person\n')).cfg.plugins.trust).toBe('person');
    expect((await load('plugins:\n  trust: companion\n')).cfg.plugins.trust).toBe('companion');
    expect((await load('plugins:\n  enabled: []\n')).cfg.plugins.trust).toBe('companion');
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/plugins\.trust/));
    expect((await load('plugins:\n  trust: everyone\n')).cfg.plugins.trust).toBe('companion');
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins\.trust "everyone".*"companion"/s);
    expect((await load('plugins:\n  trust: 3\n')).cfg.plugins.trust).toBe('companion');
  });
  it('sanctum.example.yaml parses (no duplicate keys) and loadConfig accepts it as shipped', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const yamlMod = (await import('js-yaml')).default;
    const { PROJECT_ROOT } = await import('./config.js');
    const text = readFileSync(join(PROJECT_ROOT, 'sanctum.example.yaml'), 'utf-8');
    expect(() => yamlMod.load(text)).not.toThrow();
    const { cfg } = await load(text);
    expect(cfg.plugins.trust).toBe('companion');
    expect(cfg.plugins.enabled).toEqual([]);
  });
  it('resolvePluginTrust', async () => {
    const { resolvePluginTrust } = await import('./config.js');
    expect(resolvePluginTrust(undefined)).toEqual({ trust: 'companion' });
    expect(resolvePluginTrust('person')).toEqual({ trust: 'person' });
    expect(resolvePluginTrust('PERSON').trust).toBe('companion');
    expect(resolvePluginTrust('PERSON').warning).toMatch(/not "companion" or "person"/);
  });
  it('a non-array enabled is treated as none', async () => {
    const { cfg } = await load('plugins:\n  enabled: "hello"\n');
    expect(cfg.plugins.enabled).toEqual([]);
  });
  it('the old plugins_dir key is ignored with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cfg } = await load('plugins_dir: "/x"\n');
    expect(cfg.plugins.dir).toBe('');
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins_dir.*plugins\.dir/s);
  });
  it('removed keys (nothing read them): one startup line names them, the values never reach the config, and live keys are not named', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cfg } = await load('hooks:\n  context_injection: true\n  workspace_root: ""\ngoogle:\n  enabled: true\n  client_id: gid\ncommand_center:\n  enabled: true\n  care_categories:\n    toggles: [a]\ntelegram:\n  owner_chat_id: "77"\n');
    const lines = warn.mock.calls.flat().map(String).filter((l) => l.includes('removed in this version'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/hooks\.context_injection, google\.enabled, command_center\.care_categories: ignored, removed in this version/);
    expect(lines[0]).not.toMatch(/owner_chat_id|client_id/);
    expect(cfg.hooks).not.toHaveProperty('context_injection');
    expect(cfg.google).not.toHaveProperty('enabled');
    expect(cfg.command_center).not.toHaveProperty('care_categories');
    expect(cfg.google.client_id).toBe('gid');
    expect(cfg.telegram.owner_chat_id).toBe('77'); // still read (telegram/config.ts), so still a key
  });
  it('a yaml with none of the removed keys gets no such line, and GOOGLE_ENABLED is no longer read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.GOOGLE_ENABLED = 'true';
    try {
      const { cfg } = await load('agent:\n  model: x\n');
      expect(warn.mock.calls.flat().map(String).join('\n')).not.toMatch(/removed in this version/);
      expect(cfg.google).not.toHaveProperty('enabled');
    } finally { delete process.env.GOOGLE_ENABLED; }
  });
  it('S6: the legacy warning names the new key and the value it would have migrated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load('plugins_dir: "/my/old/plugins"\n');
    expect(warn.mock.calls.flat().join('\n')).toMatch(/plugins_dir.*"\/my\/old\/plugins".*plugins\.dir: "\/my\/old\/plugins"/s);
  });
  it('S6: ~ in plugins.dir and agent.cwd expands to the home directory, not <project>/~', async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { cfg } = await load('agent:\n  cwd: "~/companion"\nplugins:\n  dir: "~/my-plugins"\n');
    expect(cfg.plugins.dir).toBe(join(homedir(), 'my-plugins'));
    expect(cfg.agent.cwd).toBe(join(homedir(), 'companion'));
  });
});

describe('discord block (pass A)', () => {
  const CWD = '/srv/companion-home';
  const norm = (raw: unknown, warn: (m: string) => void = () => {}) => normalizeDiscordConfig(raw, CWD, { warn, resolveFromRoot: (p) => pathResolve('/proj', p) });

  it('defaults: everything off, bots never, 4 and 20, 24 hours, private folder beside the home', () => {
    const d = norm(undefined);
    expect(d).toMatchObject({
      enabled: false,
      owner: { user_id: '', channel_id: '' },
      public: { enabled: false, guild_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20 },
      paused: false,
      deferral_hours: 24,
    });
    const priv = pathResolve('/srv/sanctum-private');
    expect(d.private_dir).toBe(priv);
    expect(d.gate.words_file).toBe(pathJoin(priv, 'words.txt'));
    expect(d.gate.names_file).toBe(pathJoin(priv, 'names.txt'));
    expect(d.public.exclusions_file).toBe(pathJoin(priv, 'exclusions.txt'));
  });

  it('keeps the legacy enabled flag and maps owner_user_id to owner.user_id with one warning', () => {
    const warn = vi.fn();
    const d = norm({ enabled: true, owner_user_id: '123456789012345678' }, warn);
    expect(d.enabled).toBe(true);
    expect(d.owner.user_id).toBe('123456789012345678');
    expect(d.owner_user_id).toBe('123456789012345678'); // still readable where it was
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/owner_user_id.*owner\.user_id/);
  });

  it('the one-time warning is once per process, however often the block is read', () => {
    const warn = vi.fn();
    norm({ owner_user_id: '777' }, warn);
    norm({ owner_user_id: '777' }, warn);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('owner.user_id wins over the legacy key when both are set, and says so', () => {
    const warn = vi.fn();
    const d = norm({ owner_user_id: '111', owner: { user_id: '222' } }, warn);
    expect(d.owner.user_id).toBe('222');
    expect(d.owner_user_id).toBe('222');
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/ignored|wins|222/);
  });

  it('no warning when only the new key is used', () => {
    const warn = vi.fn();
    norm({ owner: { user_id: '5', channel_id: '6' } }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('clamps deferral_hours to 1..48 and falls back to 24 for junk', () => {
    expect(norm({ deferral_hours: 0 }).deferral_hours).toBe(1);
    expect(norm({ deferral_hours: -5 }).deferral_hours).toBe(1);
    expect(norm({ deferral_hours: 100 }).deferral_hours).toBe(48);
    expect(norm({ deferral_hours: 36 }).deferral_hours).toBe(36);
    expect(norm({ deferral_hours: 'soon' }).deferral_hours).toBe(24);
    expect(norm({ deferral_hours: null }).deferral_hours).toBe(24);
  });

  it('bots is never unless it says capped; the limits are positive whole numbers', () => {
    expect(norm({ public: { bots: 'capped' } }).public.bots).toBe('capped');
    expect(norm({ public: { bots: 'always' } }).public.bots).toBe('never');
    expect(norm({ public: { bots: true } }).public.bots).toBe('never');
    expect(norm({ public: { bot_exchange_limit: 2, bot_hourly_limit: 7 } }).public).toMatchObject({ bot_exchange_limit: 2, bot_hourly_limit: 7 });
    expect(norm({ public: { bot_exchange_limit: 0, bot_hourly_limit: -3 } }).public).toMatchObject({ bot_exchange_limit: 4, bot_hourly_limit: 20 });
    // the public lane's history: how many lines of the channel's file transcript the frame carries
    expect(norm(undefined).public.history_lines).toBe(12);
    expect(norm({ public: { history_lines: 5 } }).public.history_lines).toBe(5);
    expect(norm({ public: { history_lines: 0 } }).public.history_lines).toBe(12);
    expect(norm({ public: { history_lines: 'x' } }).public.history_lines).toBe(12);
    expect(norm({ public: { history_lines: 9999 } }).public.history_lines).toBe(50);
  });

  it('public is off unless it is literally true; guild ids are strings, junk dropped', () => {
    expect(norm({ public: { enabled: 'yes' } }).public.enabled).toBe(false);
    expect(norm({ public: { enabled: true } }).public.enabled).toBe(true);
    expect(norm({ public: { guild_ids: ['1', ' 2 ', '', 3, null] } }).public.guild_ids).toEqual(['1', '2']);
  });

  it('attachments.max_mb: default 8, whole megabytes, 1..10 (files.ts saves nothing larger than 10)', () => {
    expect(norm(undefined).attachments).toEqual({ max_mb: 8 });
    expect(norm({ attachments: { max_mb: 3 } }).attachments.max_mb).toBe(3);
    expect(norm({ attachments: { max_mb: 20 } }).attachments.max_mb).toBe(10);
    expect(norm({ attachments: { max_mb: 0 } }).attachments.max_mb).toBe(8);
    expect(norm({ attachments: { max_mb: 'big' } }).attachments.max_mb).toBe(8);
  });

  it('warns when an id was written as a bare number (YAML would round it)', () => {
    const warn = vi.fn();
    norm({ owner: { user_id: 123456789012345678 } }, warn);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/quote/i);
  });

  it('expands ~ and resolves relative paths from the project root, like the plugin loader', async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const d = norm({ private_dir: '~/priv', gate: { words_file: 'lists/w.txt' }, public: { exclusions_file: '~/x/ex.txt' } });
    expect(d.private_dir).toBe(join(homedir(), 'priv'));
    expect(d.gate.words_file).toBe(pathResolve('/proj', 'lists/w.txt'));
    expect(d.gate.names_file).toBe(join(homedir(), 'priv', 'names.txt'));
    expect(d.public.exclusions_file).toBe(join(homedir(), 'x', 'ex.txt'));
  });

  it('loadConfig carries the block through, with the legacy key mapped and agent.cwd honoured', async () => {
    vi.resetModules();
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sanctum-cfg-'));
    const file = join(dir, 'sanctum.yaml');
    writeFileSync(file, 'agent:\n  cwd: "/srv/h/companion"\ndiscord:\n  enabled: true\n  owner_user_id: "42"\n  deferral_hours: 99\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await import('./config.js');
    const cfg = m.loadConfig(file);
    expect(cfg.discord.owner.user_id).toBe('42');
    expect(cfg.discord.deferral_hours).toBe(48);
    expect(cfg.discord.private_dir).toBe(pathResolve('/srv/h/sanctum-private'));
  });
});

describe('the app password is held by the config, not in process.env (provider children copy the environment)', () => {
  const load = async (envPassword: string | undefined) => {
    vi.resetModules();
    if (envPassword === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = envPassword;
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'sanctum-cfg-')), 'sanctum.yaml'); // none written: defaults
    const m = await import('./config.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return { m, file };
  };
  it('takes APP_PASSWORD from the environment at the first load, signs in with it, and leaves none in process.env', async () => {
    const { m, file } = await load('from-the-env');
    expect(m.loadConfig(file).auth.password).toBe('from-the-env');
    expect(process.env.APP_PASSWORD).toBeUndefined();
    expect(m.reloadConfig().auth.password).toBe('from-the-env'); // a reload keeps it
  });
  it('the environment value beats auth.password in sanctum.yaml (default < yaml < env)', async () => {
    const { m, file } = await load('from-the-env');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'auth:\n  password: from-the-yaml\n');
    expect(m.loadConfig(file).auth.password).toBe('from-the-env');
    expect(m.getAppPasswordSource()).toBe('parent_env');
    const again = await load(undefined);
    writeFileSync(again.file, 'auth:\n  password: from-the-yaml\n');
    expect(again.m.loadConfig(again.file).auth.password).toBe('from-the-yaml');
    expect(again.m.getAppPasswordSource()).toBe('yaml');
  });
  it('setAppPassword changes what a reload signs in with, and still puts nothing in process.env', async () => {
    const { m, file } = await load('old-one');
    m.loadConfig(file);
    m.setAppPassword('a-new-password');
    expect(process.env.APP_PASSWORD).toBeUndefined();
    expect({ ...process.env }).not.toHaveProperty('APP_PASSWORD'); // what a child gets
    expect(m.reloadConfig().auth.password).toBe('a-new-password');
  });
  it('works with no password in the environment (a first run): the holder starts empty and setAppPassword fills it', async () => {
    const { m, file } = await load(undefined);
    expect(m.loadConfig(file).auth.password).toBe('');
    m.setAppPassword('first-password');
    expect(m.reloadConfig().auth.password).toBe('first-password');
    expect(process.env.APP_PASSWORD).toBeUndefined();
  });
  describe('where the password comes from (getAppPasswordSource)', () => {
    // server.ts loads .env in its body, after config.ts has been evaluated: so what is in process.env at import time is the parent's,
    // and what appears between the import and the first load is what dotenv added.
    const fresh = async (atImport: string | undefined) => {
      vi.resetModules();
      if (atImport === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = atImport;
      const m = await import('./config.js');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'sanctum-cfg-'));
      return { m, file: join(dir, 'sanctum.yaml'), write: (text: string) => writeFileSync(join(dir, 'sanctum.yaml'), text) };
    };
    it('parent_env: APP_PASSWORD was in the environment before .env was read; a dotenv load afterwards does not change that', async () => {
      const { m, file } = await fresh('from-the-parent');
      process.env.APP_PASSWORD = 'from-the-parent'; // dotenv does not override a set variable: same value
      m.loadConfig(file);
      expect(m.getAppPasswordSource()).toBe('parent_env');
      m.setAppPassword('typed-in-the-wizard');
      expect(m.getAppPasswordSource()).toBe('parent_env'); // the parent still wins at the next start
    });
    it('dotenv: the variable appeared only after the config module was evaluated (the .env load)', async () => {
      const { m, file } = await fresh(undefined);
      process.env.APP_PASSWORD = 'from-dot-env';
      m.loadConfig(file);
      expect(m.getAppPasswordSource()).toBe('dotenv');
      expect(m.loadConfig(file).auth.password).toBe('from-dot-env');
    });
    it('yaml: no environment value at all, a password in sanctum.yaml', async () => {
      const { m, file, write } = await fresh(undefined);
      write('auth:\n  password: from-yaml-file\n');
      m.loadConfig(file);
      expect(m.getAppPasswordSource()).toBe('yaml');
    });
    it('none: nothing anywhere; after the wizard sets one it is dotenv (it was written to .env)', async () => {
      const { m, file } = await fresh(undefined);
      m.loadConfig(file);
      expect(m.getAppPasswordSource()).toBe('none');
      m.setAppPassword('first-password');
      expect(m.reloadConfig().auth.password).toBe('first-password');
      expect(m.getAppPasswordSource()).toBe('dotenv');
    });
    it('an empty APP_PASSWORD from the parent counts as none, and the wizard one is then dotenv', async () => {
      const { m, file } = await fresh('');
      m.loadConfig(file);
      expect(m.getAppPasswordSource()).toBe('none');
    });
  });
});

// Negative control for multi-tenant stage 1: with no `tenants:` block the loaded config must stay exactly what it was before tenancy
// existed. The golden was captured from the code before any tenancy change; UPDATE_GOLDEN=1 rewrites it (do that only on purpose).
describe('single-tenant config golden', () => {
  const ENV_KEYS = ['PORT', 'HOST', 'DB_PATH', 'APP_PASSWORD', 'AGENT_CWD', 'AGENT_MODEL', 'AGENT_PROVIDER', 'COMPANION_NAME', 'USER_NAME', 'TZ',
    'DISCORD_ENABLED', 'TELEGRAM_ENABLED', 'GOOGLE_ENABLED', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'WORKSPACE_ROOT', 'VAULT_PATH', 'EXTRA_WRITE_PATHS'];
  const FIXTURE = [
    'server:', '  port: 3555', '  db_path: ./data/golden.db',
    'agent:', '  cwd: ./golden-home', '  model: golden-model',
    'identity:', '  companion_name: Golden', '  timezone: Europe/Paris', '  profile_path: me.md',
    'plugins:', '  dir: ./golden-plugins', '  enabled: [alpha, beta]',
    'discord:', '  private_dir: ./golden-private',
    '',
  ].join('\n');

  const normalise = (value: unknown, root: string): unknown => {
    // A folder is replaced only when it is followed by a path separator or the end of the string, so a checkout named `sanctum` does not rewrite
    // its sibling `<ROOT>/../sanctum-private` into `<ROOT>-private`.
    const folder = (dir: string) => new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/]|$)`, 'g');
    if (typeof value === 'string') return value.replace(folder(root), '<ROOT>').replace(folder(pathDirname(root)), '<ROOT>/..').replace(/\\/g, '/');
    if (Array.isArray(value)) return value.map((v) => normalise(v, root));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, root)]));
    return value;
  };

  it('loadConfig() with no tenants block equals the committed golden', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(pathJoin(tmpdir(), 'sanctum-golden-'));
      const run = async (text: string) => {
        vi.resetModules();
        const m = await import('./config.js');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const file = pathJoin(dir, 'sanctum.yaml');
        writeFileSync(file, text);
        return normalise(JSON.parse(JSON.stringify(m.loadConfig(file))), m.PROJECT_ROOT);
      };
      const actual = { empty: await run(''), fixture: await run(FIXTURE) };
      const goldenPath = pathJoin(pathResolve(__dirname), 'test-golden', 'config-single-tenant.json');
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n');
      expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, 'utf8')));
    } finally {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

describe('yaml switch words are coerced to booleans at load', () => {
  const load = async (yamlText: string) => {
    vi.resetModules();
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'sanctum-cfg-')), 'sanctum.yaml');
    writeFileSync(file, yamlText);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await import('./config.js');
    return { cfg: m.loadConfig(file) as any, warn };
  };
  it('no / off / "false" are false and yes is true, whatever the key (every boolean default is a switch)', async () => {
    const { cfg, warn } = await load('agent:\n  app_write: no\n  codex:\n    network_access: "off"\norchestrator:\n  enabled: off\nvoice:\n  enabled: "false"\nimagegen:\n  safety_checker: yes\ncommand_center:\n  enabled: On\n');
    expect(cfg.agent.app_write).toBe(false);
    expect(cfg.agent.codex.network_access).toBe(false);
    expect(cfg.orchestrator.enabled).toBe(false);
    expect(cfg.voice.enabled).toBe(false);
    expect(cfg.imagegen.safety_checker).toBe(true);
    expect(cfg.command_center.enabled).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('switch'))).toHaveLength(0);
  });
  it('a word that is not one is false with one warning; an empty value leaves the default', async () => {
    const { cfg, warn } = await load('agent:\n  app_write: maybe\norchestrator:\n  enabled: ~\n');
    expect(cfg.agent.app_write).toBe(false);
    expect(cfg.orchestrator.enabled).toBe(true); // the shipped default
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('not true/false/yes/no/on/off/1/0'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent.app_write: "maybe"');
  });
});
