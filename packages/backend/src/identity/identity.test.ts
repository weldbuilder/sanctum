import { describe, it, expect, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { SanctumConfig } from '../config.js';
import { loadCompanionIdentity } from './load.js';
import { identityFiles } from '../services/identity/source.js';
import { describeIdentitySource, renderIdentityPrompt, fillIdentityNames } from './render.js';

function makeConfig(overrides: Partial<SanctumConfig> = {}): SanctumConfig {
  const root = resolve('.');
  const base: SanctumConfig = {
    plugins: { dir: '', ledger_dir: '', enabled: [], trust: 'companion' },
    identity: {
      companion_name: 'Echo',
      user_name: 'User',
      timezone: 'UTC',
      profile_path: resolve(root, 'identity/companion.profile.yaml'),
      companion_md_path: resolve(root, 'identity/companion.md'),
    },
    server: { port: 3002, host: '127.0.0.1', db_path: ':memory:' },
    auth: { password: '' },
    agent: {
      cwd: root,
      claude_md_path: resolve(root, 'CLAUDE.md'),
      mcp_json_path: resolve(root, '.mcp.json'),
      model: 'claude-sonnet-4-6',
      model_autonomous: 'claude-sonnet-4-6',
      auto_compact: false,
      dsh: { command: 'dsh', model: '', model_autonomous: '', model_provider: '', api_key_env: '', base_url: '', home: '', sandbox_mode: 'workspace-write', base_instructions_file: '' },
      rolling: { claude: true, codex: true, model: '', model_provider: '', tail_chars: 14000, fold_chars: 6000, keep_chars: 6000, tail_turns: 24, max_segments: 5, segment_cap: 2000, history_max_chars: 24000, history_max_turns: 30, summarizer_instructions_file: '' },
      summarizer: { provider: '', model: '', base_url: '', api_key_env: 'SUMMARIZER_API_KEY', max_output_tokens: 2000 },
      provider: 'claude',
      codex: { model: '', model_autonomous: '', sandbox_mode: 'workspace-write', network_access: true, additional_directories: [], base_instructions_file: '' },
    },
    orchestrator: {
      enabled: true,
      wake_prompts_path: resolve(root, 'prompts/wake.md'),
      wake_prompts_dir: resolve(root, 'prompts/wakes'),
      schedules: {},
      failsafe: { enabled: false, gentle_minutes: 120, concerned_minutes: 720, emergency_minutes: 1440 },
    },
    handoff: { enabled: false },
    hooks: { safe_write_prefixes: [], workspace_root: '', vault_path: '', extra_write_paths: [] },
    voice: { enabled: false, elevenlabs_voice_id: '' },
    imagegen: { provider: 'none', model: '', reference_model: '', size: '1024x1024', safety_checker: false, timeout_ms: 90000 },
    media: { gif_rating: 'pg-13' },
    discord: {
      enabled: false, owner_user_id: '', owner: { user_id: '', channel_id: '' },
      public: { enabled: false, guild_ids: [], role_ids: [], bots: 'never', bot_exchange_limit: 4, bot_hourly_limit: 20, history_lines: 12, exclusions_file: '' },
      gate: { words_file: '', names_file: '' }, attachments: { max_mb: 8 }, paused: false, deferral_hours: 24, private_dir: '',
    },
    telegram: { enabled: false, owner_chat_id: '' },
    integrations: { life_api_url: '', browser_url: '', mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } },
    google: { client_id: '', client_secret: '' },
    command_center: {
      enabled: false,
      default_person: 'user',
      currency_symbol: '$',
    },
    cors: { origins: [] },
    revien: { enabled: false, url: 'http://127.0.0.1:7437', recall_limit: 6, timeout_ms: 2500 },
    updates: { check: false, repo: '', branch: 'main' },
  };

  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...overrides.identity },
    agent: { ...base.agent, ...overrides.agent },
  };
}

const STARTER = resolve(__dirname, '../../../../companion-home/identity');
const tmpHome = () => mkdtempSync(join(tmpdir(), 'sanctum-identity-'));
const writeId = (home: string, name: string, text: string) => {
  mkdirSync(join(home, 'identity'), { recursive: true });
  writeFileSync(join(home, 'identity', name), text);
};
const homeConfig = (home: string, identity: Partial<SanctumConfig['identity']> = {}) => makeConfig({
  identity: { companion_name: 'Avery', user_name: 'Jordan', timezone: 'UTC', profile_path: '', companion_md_path: '', ...identity },
  agent: { ...makeConfig().agent, cwd: home, claude_md_path: join(home, 'CLAUDE.md') },
});

describe('identity rendering', () => {
  it('reads the starter files from the companion home, not from the project root (the defect)', () => {
    // companion-home/identity is what setup copies into a new home: profile.md and companion.md.
    const home = tmpHome();
    mkdirSync(join(home, 'identity'));
    for (const f of ['profile.md', 'companion.md']) copyFileSync(join(STARTER, f), join(home, 'identity', f));
    const identity = loadCompanionIdentity(homeConfig(home));
    expect(identity.mode).toBe('profile');
    const prompt = renderIdentityPrompt(identity);
    expect(prompt).toContain('# Companion Identity');
    expect(prompt).toContain('## Companion Narrative');
    expect(prompt).toContain(readFileSync(join(STARTER, 'companion.md'), 'utf-8').trim().split('\n')[0]);
    expect(describeIdentitySource(identity)).toContain('profile.md');
  });

  it('loads a structured profile and a narrative from the home', () => {
    const home = tmpHome();
    writeId(home, 'companion.profile.yaml', [
      'companion:', '  name: Avery', '  role: collaborator', 'user:', '  name: Jordan',
      'relationship:', '  boundaries:', '    - Do not imitate the primary companion',
      'voice:', '  style:', '    - warm', 'values:', '  - continuity', '',
    ].join('\n'));
    writeId(home, 'companion.md', 'Avery is steady, direct, and careful.');
    const identity = loadCompanionIdentity(homeConfig(home));
    expect(identity.mode).toBe('profile');
    expect(describeIdentitySource(identity)).toContain('companion.profile.yaml');
    const prompt = renderIdentityPrompt(identity);
    expect(prompt).toContain('Companion name: Avery');
    expect(prompt).toContain('User name: Jordan');
    expect(prompt).toContain('Do not imitate the primary companion');
    expect(prompt).toContain('Avery is steady, direct, and careful.');
  });

  it('falls back to legacy CLAUDE.md only when the home has no identity folder at all', () => {
    const home = tmpHome();
    writeFileSync(join(home, 'CLAUDE.md'), '# Personal AI System Prompt\nlegacy');
    const legacy = loadCompanionIdentity(homeConfig(home));
    expect(legacy.mode).toBe('legacy-claude');
    expect(renderIdentityPrompt(legacy)).toContain('# Personal AI System Prompt');

    mkdirSync(join(home, 'identity')); // a folder with nothing in it is still an identity folder: no fallback
    const empty = loadCompanionIdentity(homeConfig(home));
    expect(empty.mode).toBe('profile');
    expect(renderIdentityPrompt(empty)).toBe('');
  });

  it('every regular file in the folder is read; avatars, dot files and links are not', () => {
    const home = tmpHome();
    writeId(home, 'profile.md', 'P');
    writeId(home, 'notes.md', 'NOTES TEXT');
    writeId(home, 'avatar.png', 'not text');
    writeId(home, '.profile.md.tmp-1', 'TEMP');
    writeFileSync(join(home, 'outside.md'), 'OUTSIDE');
    try { symlinkSync(join(home, 'outside.md'), join(home, 'identity', 'link.md')); } catch { /* no symlinks here */ }
    const prompt = renderIdentityPrompt(loadCompanionIdentity(homeConfig(home)));
    expect(prompt).toContain('NOTES TEXT');
    expect(prompt).toContain('## notes.md');
    expect(prompt).not.toContain('not text');
    expect(prompt).not.toContain('TEMP');
    expect(prompt).not.toContain('OUTSIDE');
  });

  it('matches the standard names case-folded', () => {
    const home = tmpHome();
    writeId(home, 'Companion.MD', 'NARRATIVE');
    writeId(home, 'PROFILE.md', 'PROFILE');
    const prompt = renderIdentityPrompt(loadCompanionIdentity(homeConfig(home)));
    expect(prompt).toContain('## Companion Narrative\n\nNARRATIVE');
    expect(prompt).toContain('# Companion Identity\n\nPROFILE');
    expect(prompt).not.toContain('## Companion.MD');
  });

  it('an identity folder that is a link out of the home is refused, not followed', () => {
    const home = tmpHome();
    const elsewhere = tmpHome();
    writeFileSync(join(elsewhere, 'profile.md'), 'ELSEWHERE');
    try { symlinkSync(elsewhere, join(home, 'identity'), 'dir'); } catch { return; }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const identity = loadCompanionIdentity(homeConfig(home));
    warn.mockRestore();
    expect(renderIdentityPrompt(identity)).toBe('');
  });

  it('identity.profile_path and companion_md_path are overrides, read from the home', () => {
    const home = tmpHome();
    writeId(home, 'me.yaml', 'companion:\n  name: Override\n');
    writeId(home, 'story.md', 'STORY');
    const identity = loadCompanionIdentity(homeConfig(home, { profile_path: join(home, 'identity', 'me.yaml'), companion_md_path: join(home, 'identity', 'story.md') }));
    const prompt = renderIdentityPrompt(identity);
    expect(prompt).toContain('Companion name: Override');
    expect(prompt).toContain('## Companion Narrative\n\nSTORY');
    expect(prompt).not.toContain('## story.md');
  });

  it('an override outside the identity folder is ignored, with a warning', () => {
    const home = tmpHome();
    writeId(home, 'companion.md', 'IN THE FOLDER');
    writeFileSync(join(home, 'elsewhere.md'), 'NOT RATIFIABLE');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = renderIdentityPrompt(loadCompanionIdentity(homeConfig(home, { companion_md_path: join(home, 'elsewhere.md') })));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(prompt).toContain('IN THE FOLDER');
    expect(prompt).not.toContain('NOT RATIFIABLE');
  });
});

describe('identityFiles', () => {
  it('is the set the harnesses read: regular files directly in identity/, sorted, without avatars and dot files', () => {
    const home = tmpHome();
    writeId(home, 'profile.md', 'P');
    writeId(home, 'companion.md', 'C');
    writeId(home, 'companion.profile.yaml', 'companion:\n  name: A\n');
    writeId(home, 'avatar.webp', 'img');
    writeId(home, '.secret', 'x');
    mkdirSync(join(home, 'identity', 'sub'));
    expect(identityFiles(home).map((f) => f.name)).toEqual(['companion.md', 'companion.profile.yaml', 'profile.md']);
  });
});

describe('fillIdentityNames', () => {
  const names = { companion_name: 'Echo', user_name: 'Alex' };
  it('fills the template names and the starter file\'s literal placeholder', () => {
    expect(fillIdentityNames('- **Name:** (configured in sanctum.yaml)\nHi {{companion_name}}, this is {{ user_name }}.', names))
      .toBe('- **Name:** Echo\nHi Echo, this is Alex.');
    expect(fillIdentityNames('- **Name:** (configured in resonant.yaml)', names)).toBe('- **Name:** Echo');
  });
  it('leaves other text alone', () => {
    expect(fillIdentityNames('Name: Nox', names)).toBe('Name: Nox');
  });
});
