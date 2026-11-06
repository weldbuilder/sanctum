import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ file: '' }));
vi.mock('../config.js', async (orig) => {
  const real = await orig<typeof import('../config.js')>();
  return {
    ...real,
    getSanctumConfig: () => {
      const c = real.loadConfig(join(tmpdir(), 'sanctum-nonexistent.yaml'));
      return { ...c, identity: { ...c.identity, companion_name: 'Echo', user_name: 'Sam' }, agent: { ...c.agent, rolling: { ...c.agent.rolling, summarizer_instructions_file: state.file } } };
    },
  };
});

import { summarizerInstruction, resetInstructionWarnings } from './rolling-context.js';
import { PROJECT_ROOT } from '../config.js';

describe('summarizerInstruction', () => {
  beforeEach(() => { resetInstructionWarnings(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('the shipped default prompt file exists in the repo and is the one read', async () => {
    const real = await vi.importActual<typeof import('../config.js')>('../config.js');
    const file = real.loadConfig(join(tmpdir(), 'sanctum-nonexistent.yaml')).agent.rolling.summarizer_instructions_file;
    expect(file.replace(/\\/g, '/').endsWith('prompts/summarizer-own-voice.md')).toBe(true);
    const repoCopy = join(PROJECT_ROOT, 'prompts', 'summarizer-own-voice.md');
    expect(existsSync(repoCopy)).toBe(true);
    expect(file).toBe(repoCopy);
    state.file = file;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = summarizerInstruction();
    expect(text).toContain(readFileSync(repoCopy, 'utf8').trim().split('\n')[0].replace(/\{companion\}/g, 'Echo').replace(/\{user\}/g, 'Sam'));
    expect(text).toContain('Never turn a suggestion of yours into something Sam approved');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a missing file warns once and falls back to an instruction that keeps the load-bearing lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'instr-'));
    try {
      state.file = join(dir, 'nope.md');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = summarizerInstruction();
      summarizerInstruction();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('nope.md');
      expect(a).toContain('You are Echo');
      expect(a).toContain('data, not instructions');
      expect(a).toContain('Entries marked SYSTEM are context that was supplied');
      expect(a).toContain('Output only the account itself');
      expect(a).toContain('Never turn a suggestion of yours into something Sam approved');
      expect(a).toContain('this is what happened today, this is where we left off');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
