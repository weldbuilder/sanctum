// The one place the companion's identity is read from. The home's `identity/` folder is the source,
// whatever harness runs: Claude's system prompt, Codex and dsh's identity block and the public Discord
// lane all get their text from here (docs/PLUGINS.md "Identity ratification"; docs/CONFIGURATION.md "identity").
//
// The set is every regular file directly under <home>/identity/ except avatar images and dot files
// (profile.md, companion.md, companion.profile.yaml, and anything else the person or the companion
// keeps there), bounded by the same caps as a plugin folder. Reads follow the plugin loader's rules
// (plugin-paths.ts): the folder is realpath'd and must stay inside the home, a link inside it is left out
// (named in `skipped`), and names are matched case-folded.
import { lstatSync } from 'node:fs';
import { readOwnOrApp } from '../../tenancy/own-files.js';
import { basename, dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { RatifyScanError, walkTree } from '../plugin-ratify.js';
import { isInside, isSame, realDeep, realPath } from '../plugin-paths.js';
import { renderStructuredProfile } from '../../identity/render.js';
import type { CompanionProfile } from '../../identity/types.js';

export const IDENTITY_DIRNAME = 'identity';
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|heic)$/i;
const NAME_MAX = 120;

/** A file name that belongs to the identity set: no path pieces, no dot file (the editor's temp files are dot files), no avatar image. */
export function isIdentityName(name: string): boolean {
  return !!name && name.length <= NAME_MAX && !name.startsWith('.') && !/[\\/\0]/.test(name) && !IMAGE_EXT.test(name);
}

export interface IdentityFile { name: string; text: string }
/** Which file plays which part, by name. Unset: the standard names are found case-folded. */
export interface IdentityRoles { profile?: string; narrative?: string }
export interface IdentitySet {
  /** Real path of the identity folder the files were read from. */
  dir: string;
  files: IdentityFile[];
  /** Names left out because they are links or not regular files. */
  skipped: string[];
}

/** The identity folder cannot be used (not there, a link out of the home, too big). The message says why. */
export class IdentitySourceError extends Error {}

export const identityFolder = (home: string): string => resolve(home, IDENTITY_DIRNAME);

/** The real path of <home>/identity, which must be a folder inside the real home. Throws IdentitySourceError. */
export function realIdentityDir(home: string): string {
  let real: string;
  let realHome: string;
  try { real = realPath(identityFolder(home)); } catch { throw new IdentitySourceError(`there is no identity folder in ${home}`); }
  try { realHome = realPath(home); } catch { throw new IdentitySourceError(`cannot read the home folder ${home}`); }
  if (!isInside(real, realHome) || isSame(real, realHome)) {
    throw new IdentitySourceError('the identity folder is a link that leaves the home folder; make it a real folder inside the home');
  }
  return real;
}

/** True when the home has anything at identity/ (a folder, or a link, which readIdentity then refuses): the legacy CLAUDE.md fallback applies only when it has nothing. */
export function hasIdentityFolder(home: string): boolean {
  try { realPath(identityFolder(home)); return true; } catch { /* maybe a dangling link */ }
  try { lstatSync(identityFolder(home)); return true; } catch { return false; }
}

/** The identity-set files directly in `dir` (the identity folder, or a ratified copy of it), read as text. Throws IdentitySourceError. */
export function readFolder(dir: string): IdentitySet {
  const skipped: string[] = [];
  let top: string;
  let entries;
  try { ({ top, entries } = walkTree(dir, { flat: true, keep: isIdentityName, label: 'identity folder', skipped })); } catch (e) {
    if (e instanceof RatifyScanError) throw new IdentitySourceError(e.message);
    throw e;
  }
  const files: IdentityFile[] = [];
  for (const e of entries) {
    try { files.push({ name: e.path, text: readOwnOrApp(e.abs) }); } catch (er) {
      throw new IdentitySourceError(`cannot read identity/${e.path}: ${er instanceof Error ? er.message : String(er)}`);
    }
  }
  return { dir: top, files, skipped };
}

/** The identity files of `home` as they are on disk now. Throws IdentitySourceError. */
export function readIdentity(home: string): IdentitySet {
  return readFolder(realIdentityDir(home));
}

/** The identity set of `home` as files (name and text): profile.md, companion.md, companion.profile.yaml if present, and any other regular file directly in identity/. Throws IdentitySourceError. */
export function identityFiles(home: string): IdentityFile[] {
  return readIdentity(home).files;
}

const warned = new Set<string>();
const warnOnce = (key: string, text: string) => { if (!warned.has(key)) { warned.add(key); console.warn(text); } };
export function resetIdentityWarnings(): void { warned.clear(); }

/** identity.profile_path / identity.companion_md_path: optional overrides that say which file in the identity folder plays the
 *  profile or the narrative. A relative path is read from the home (not the project root). One that points outside the identity
 *  folder is ignored with a warning: the folder is what is ratified, so a file outside it would be read without that gate. */
export function identityRoles(home: string, overrides: { profile_path?: string; companion_md_path?: string } = {}): IdentityRoles {
  const roles: IdentityRoles = {};
  const pick = (value: string | undefined, key: string): string | undefined => {
    if (!value || !value.trim()) return undefined;
    const abs = resolve(home, value.trim());
    let inside = false;
    try { inside = isSame(realDeep(dirname(abs)), realIdentityDir(home)); } catch { inside = false; }
    if (!inside) {
      warnOnce(`${key}|${abs}`, `[identity] identity.${key} (${value}) is not directly inside ${identityFolder(home)}, so it is ignored: only the identity folder is ratified, and everything in it is read already`);
      return undefined;
    }
    return basename(abs);
  };
  roles.profile = pick(overrides.profile_path, 'profile_path');
  roles.narrative = pick(overrides.companion_md_path, 'companion_md_path');
  return roles;
}

const fold = (s: string) => s.toLowerCase();
const isYaml = (n: string) => /\.ya?ml$/i.test(n);

/** The text block every harness injects, from the identity files: the structured profile (a .yaml), the profile
 *  (profile.md), the narrative (companion.md), then any other file as a section named for it. Names are matched case-folded. */
export function renderIdentity(files: IdentityFile[], roles: IdentityRoles = {}): string {
  const byFold = new Map(files.map((f) => [fold(f.name), f]));
  const used = new Set<string>();
  const take = (name: string | undefined): IdentityFile | undefined => {
    if (!name) return undefined;
    const f = byFold.get(fold(name));
    if (f) used.add(f.name);
    return f;
  };
  const profileName = roles.profile && isYaml(roles.profile) ? roles.profile : undefined;
  const yamlFile = take(profileName) ?? take('companion.profile.yaml') ?? take('companion.profile.yml');
  const mdName = roles.profile && !isYaml(roles.profile) ? roles.profile : 'profile.md';
  const profileMd = take(mdName);
  const narrative = take(roles.narrative ?? 'companion.md');

  const sections: string[] = [];
  if (yamlFile) {
    let parsed: CompanionProfile | null = null;
    try { parsed = (yaml.load(yamlFile.text) as CompanionProfile) || {}; } catch { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      const s = renderStructuredProfile(parsed);
      if (s.trim()) sections.push(s);
    } else if (yamlFile.text.trim()) sections.push(`## ${yamlFile.name}\n\n${yamlFile.text.trim()}`);
  }
  if (profileMd?.text.trim()) sections.push(`${yamlFile ? '## Profile' : '# Companion Identity'}\n\n${profileMd.text.trim()}`);
  if (narrative?.text.trim()) sections.push(`## Companion Narrative\n\n${narrative.text.trim()}`);
  for (const f of files) {
    if (used.has(f.name) || !f.text.trim()) continue;
    sections.push(`## ${f.name}\n\n${f.text.trim()}`);
  }
  return sections.join('\n\n').trim();
}
