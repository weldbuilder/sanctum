// Types for scripts/updater-core.mjs, which the backend's updater service imports.
export class UpdateError extends Error {
  restored: boolean;
  dirty?: string[];
  constructor(message: string, opts?: { restored?: boolean; dirty?: string[] });
}
export interface UpdateSettings { repo: string; branch: string; cwd: string; dbPath: string }
export interface RollbackInfo { available: boolean; version: string | null; created_at: string | null; mode: string | null }
export interface SelfUpdateSupport { ok: boolean; mode: 'git' | 'tarball'; reason?: string }
export type UpdateResult =
  | { upToDate: true; current: string; latest: string }
  | { upToDate: false; from: string; to: string; mode: 'git' | 'tarball'; sha: string | null; toSha: string | null };
export interface RunUpdateOptions {
  root: string;
  dataDir: string;
  force?: boolean;
  log?: (line: string) => void;
  setState?: (state: string) => void;
  fetchFn?: typeof fetch;
  settings?: UpdateSettings;
}
export function readEnvFile(root: string): void;
export function dataDirFor(root: string, dbPath?: string): string;
export function readVersion(root: string): string;
export function readUpdateSettings(root: string): Promise<UpdateSettings>;
export function isNewer(a: string, b: string): boolean;
export function selfUpdateSupport(root: string): SelfUpdateSupport;
export function installMode(root: string): 'git' | 'tarball';
export function runUpdate(opts: RunUpdateOptions): Promise<UpdateResult>;
export function runRollback(opts: { root: string; dataDir: string; log?: (line: string) => void }): Promise<{ version: string; mode: string }>;
export function rollbackNow(opts: { root: string; dataDir: string; log?: (line: string) => void; force?: boolean; depsTouched?: boolean }): Promise<{ version: string; mode: string }>;
export function rollbackInfo(dataDir: string): RollbackInfo;
export function readRollback(dataDir: string): { dir: string; manifest: Record<string, any> } | null;
export function rollbackRoot(dataDir: string): string;
export function clearRollback(dataDir: string): void;
export function makeRollbackCopy(opts: { root: string; dataDir: string; version: string; mode: string; branch: string; sha?: string | null; extra?: string[] }): Record<string, any>;
