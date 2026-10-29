// Where the private lists live, and whether the companion could reach them.
//
// The word list, the name list and the exclusions file are the one thing the companion must not be
// able to read or edit: a companion that can write the gate's list can empty it. So the private
// folder (and each list file, if set separately) is held to the same rule the plugin loader applies
// to plugins.dir: realpath, and refused, loudly, when it is inside (or contains) any folder the
// companion can write. The check is the plugin loader's own (writableClash), not a copy of it.
//
// Under Codex or dsh at `danger-full-access` the companion can write anywhere the OS user can, so no
// folder is out of its reach and the check above proves nothing: the lists are refused outright, the way
// the plugin loader refuses plugins (pluginsDisabled), with one loud warning naming the setting. Claude
// has no sandbox mode and is not refused; its write-gate covers Write/Edit only and Bash is ungated under
// bypassPermissions (docs/DISCORD-PLAN.md, docs/CONFIGURATION.md say so).

import { resolve } from 'node:path';
import { getSanctumConfig } from '../../config.js';
import { tenantLocal } from '../../tenancy/context.js';
import { fullAccessSetting, isInside, realOrResolved, writableClash } from '../plugins.js';

export interface RefusedPath {
  /** The config key, e.g. discord.private_dir. */
  key: string;
  path: string;
  /** The companion-writable root it clashes with, e.g. agent.cwd. */
  clash: string;
}

export interface DiscordPaths {
  /** '' when refused. */
  privateDir: string;
  wordsFile: string;
  namesFile: string;
  exclusionsFile: string;
  refused: RefusedPath[];
}

const warnedLocal = tenantLocal(() => new Set<string>()); // (per tenant: one tenant's refused path is warned about under its own boot)

/** Resolve and vet the Discord paths from a loaded config. A refused path comes back as ''. */
export function resolveDiscordPaths(cfg: any, opts: { warn?: (msg: string) => void } = {}): DiscordPaths {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const d = cfg?.discord ?? {};
  const refused: RefusedPath[] = [];

  const refuse = (key: string, path: string, clash: { label: string; path: string }) => {
    refused.push({ key, path, clash: clash.label });
    const msg = `[discord] ${key} ${path} refused: it is inside (or contains) ${clash.label} ${clash.path}, which the companion can write, so it could read or change your private lists (the word gate's list among them). The Discord lists are treated as missing, so the gate blocks every outgoing message until ${key} points outside every folder the companion can write.`;
    { const W = warnedLocal.get(); if (!W.has(msg)) { W.add(msg); warn(msg); } }
  };

  const fullAccess = fullAccessSetting(cfg);
  if (fullAccess) {
    const msg = `[discord] the private lists are REFUSED: ${fullAccess} is "danger-full-access", so the companion can write anywhere on this machine, including your word list, name list and exclusions file, and could empty them. The Discord lists are treated as missing, so the gate blocks every outgoing message and the public lane is silent until ${fullAccess} is "workspace-write" or "read-only" and the app is restarted.`;
    { const W = warnedLocal.get(); if (!W.has(msg)) { W.add(msg); warn(msg); } }
    const raw = (k: unknown) => (typeof k === 'string' ? k : '');
    const clash = 'full_access';
    return {
      privateDir: '', wordsFile: '', namesFile: '', exclusionsFile: '',
      refused: [
        { key: 'discord.private_dir', path: raw(d.private_dir), clash },
        { key: 'discord.gate.words_file', path: raw(d.gate?.words_file), clash },
        { key: 'discord.gate.names_file', path: raw(d.gate?.names_file), clash },
        { key: 'discord.public.exclusions_file', path: raw(d.public?.exclusions_file), clash },
      ],
    };
  }

  const privateDirRaw: string = typeof d.private_dir === 'string' ? d.private_dir : '';
  let privateClash: { label: string; path: string } | null = null;
  if (privateDirRaw) {
    privateClash = writableClash(privateDirRaw, cfg);
    if (privateClash) refuse('discord.private_dir', privateDirRaw, privateClash);
  }

  const vet = (key: string, p: unknown): string => {
    const path = typeof p === 'string' ? p : '';
    if (!path) return '';
    // Inside a refused private folder is refused with it, even when the file itself clashes with nothing
    // (the folder was refused because it CONTAINS a writable root).
    if (privateClash && (isInside(resolve(path), resolve(privateDirRaw)) || isInside(realOrResolved(path), realOrResolved(privateDirRaw)))) {
      refused.push({ key, path, clash: privateClash.label });
      return '';
    }
    const clash = writableClash(path, cfg);
    if (clash) { refuse(key, path, clash); return ''; }
    return path;
  };

  return {
    privateDir: privateClash ? '' : privateDirRaw,
    wordsFile: vet('discord.gate.words_file', d.gate?.words_file),
    namesFile: vet('discord.gate.names_file', d.gate?.names_file),
    exclusionsFile: vet('discord.public.exclusions_file', d.public?.exclusions_file),
    refused,
  };
}

/** The vetted paths for the running config. */
export function getDiscordPaths(): DiscordPaths {
  return resolveDiscordPaths(getSanctumConfig());
}

/** Test hook: forget which problems were already warned about. */
export function resetPathWarnings(): void { warnedLocal.get().clear(); }
