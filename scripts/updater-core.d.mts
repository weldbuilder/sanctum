// Types for scripts/updater-core.mjs, which the backend's updater service imports.
export class UpdateError extends Error {
  restored: boolean;
  dirty?: string[];
  constructor(message: string, opts?: { restored?: boolean; dirty?: string[] });
}
export interface UpdateSettings { repo: string; branch: string; cwd: string; dbPath: string; repoExplicit?: boolean }
export interface RollbackInfo { available: boolean; version: string | null; created_at: string | null; mode: string | null }
export interface SelfUpdateSupport { ok: boolean; mode: 'git' | 'tarball'; reason?: string }
export interface StagedPlan {
  upToDate: false;
  staged: true;
  from: string;
  to: string;
  mode: 'git' | 'tarball';
  sha: string | null;
  toSha: string | null;
  branch: string;
  files: string[];
}
export type UpdateResult =
  | { upToDate: true; current: string; latest: string; already?: boolean }
  | { upToDate: false; from: string; to: string; mode: 'git' | 'tarball'; sha: string | null; toSha: string | null };
export interface RunUpdateOptions {
  root: string;
  force?: boolean;
  log?: (line: string) => void;
  setState?: (state: string) => void;
  fetchFn?: typeof fetch;
  settings?: UpdateSettings;
  signal?: AbortSignal;
}
export function readEnvFile(root: string): void;
export function dataDirFor(root: string, dbPath?: string): string;
export function readVersion(root: string): string;
export function repoFromPackage(pkg: Record<string, unknown>): string;
export function readUpdateSettings(root: string): Promise<UpdateSettings>;
export function isNewer(a: string, b: string): boolean;
export function selfUpdateSupport(root: string): SelfUpdateSupport;
export function installMode(root: string): 'git' | 'tarball';
export function originRepo(root: string): string;
export function resolveRepo(root: string, opts: { repo: string; explicit?: boolean }): { repo: string; note?: string; error?: string };
export function stageDir(root: string): string;
export function stageUpdate(opts: RunUpdateOptions): Promise<{ upToDate: true; current: string; latest: string; already?: boolean } | StagedPlan>;
export function applyStaged(opts: { root: string; plan: StagedPlan; log?: (line: string) => void }): Promise<UpdateResult>;
export function discardStage(root: string, log?: (line: string) => void): Promise<boolean>;
export function recoverInterruptedSwap(root: string, log?: (line: string) => void): Promise<boolean>;
export function runUpdate(opts: RunUpdateOptions): Promise<UpdateResult>;
export function runRollback(opts: { root: string; log?: (line: string) => void }): Promise<{ version: string; mode: string }>;
export function rollbackNow(opts: { root: string; log?: (line: string) => void; force?: boolean }): Promise<{ version: string; mode: string }>;
export function rollbackInfo(root: string): RollbackInfo;
export function readRollback(root: string): { dir: string; manifest: Record<string, any> } | null;
export function rollbackRoot(root: string): string;
export function rollbackNextRoot(root: string): string;
export interface RecoveryResult { changed: boolean; outcome: 'nothing' | 'restored' | 'adopted' | 'failed' | 'refused'; detail: string; phase?: string; version?: string; toVersion?: string; at?: string }
export function takeRecoveryResult(root: string): RecoveryResult | null;
export function recoverDetailed(root: string, opts?: { log?: (line: string) => void; retry?: boolean }): RecoveryResult;
export function recoverRetry(root: string, log?: (line: string) => void): Promise<RecoveryResult>;
export function procStartTime(pid: number): string;
export function errorTail(lines: string[]): string[];
export function clearRollback(root: string): void;
export function makeRollbackCopy(opts: { root: string; version: string; mode: string; branch: string; sha?: string | null; entries?: string[] }): Promise<Record<string, any>>;
export function protectedPaths(root: string, cwd?: string): string[];
export function killProcessGroup(pid: number, signal?: string, kill?: (pid: number, signal?: string) => unknown, platform?: string, taskkill?: (pid: number) => { status: number | null } | undefined): boolean;
export function killAllChildren(signal?: string, kill?: (pid: number, signal?: string) => unknown): void;
export function miniYaml(text: string): Record<string, any>;
