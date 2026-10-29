// Types for scripts/own-files-lib.mjs: the tenant write layer, the boot scan and the tenants.dir rule.
import type { CopySyncOptions, MakeDirectoryOptions, RmOptions, WriteFileOptions } from 'node:fs';
export class OwnFileRefused extends Error { code: 'tenant_refused' }
export type WriteOp = 'write' | 'mkdir' | 'chmod' | 'cp' | 'assert-real' | 'read';
export function stripLongPrefix(p: string): string;
export function nativeReal(p: string): string;
export function ownTargetProblem(tenantDir: string, target: string, op?: WriteOp): string | null;
export function ownWritePlan(tenantDir: string, target: string, op?: WriteOp, allowProcess?: boolean): { abs: string; problem: string; plain: boolean };
/** `{ process: true }`: the explicit allowance for a genuinely process-level write that runs inside a tenant context. */
export interface ProcessAllowance { process?: boolean }
export type WriteOpts = WriteFileOptions | (Exclude<WriteFileOptions, string | null | undefined> & ProcessAllowance);
export function splitProcess<T>(options: T | undefined): { options: T | undefined; allow: boolean };
export function setAfterReadCheckForTest(fn: ((abs: string) => void) | null): void;
export function setTempNameForTest(fn: ((abs: string) => string) | null): void;
export function tempNameFor(abs: string): string;
export function ownWriteFile(tenantDir: string, path: string, data: string | NodeJS.ArrayBufferView, options?: WriteOpts): void;
export function ownAppendFile(tenantDir: string, path: string, data: string | NodeJS.ArrayBufferView, options?: WriteOpts): void;
export function ownMkdir(tenantDir: string, path: string, options?: (MakeDirectoryOptions & ProcessAllowance) | number): string | undefined | void;
export function ownChmod(tenantDir: string, path: string, mode: number | string, opts?: ProcessAllowance): void;
export function ownCopyFile(tenantDir: string, src: string, dest: string, flags?: number, opts?: ProcessAllowance): void;
export function ownCp(tenantDir: string, src: string, dest: string, options?: CopySyncOptions & ProcessAllowance): void;
export function ownRename(tenantDir: string, from: string, to: string, opts?: ProcessAllowance): void;
export function ownRm(tenantDir: string, path: string, options?: RmOptions & ProcessAllowance): void;
export function ownUnlink(tenantDir: string, path: string, opts?: ProcessAllowance): void;
export const SCAN_LOG_ABOVE: number;
export function tenantFilesProblem(tenantDir: string, opts?: { quick?: boolean; only?: boolean; extra?: string[]; log?: (line: string) => void }): string;
export function isInsideTenantDir(dir: string, p: string): boolean;
export function tenantsDirProblem(tenantsDir: string, appRoot: string): string;
export function tenantHoldsAppProblem(tenantDir: string, appRoot: string): string;
export function ownWriteFileAtomic(tenantDir: string, path: string, data: string | Buffer, opts?: { mode?: number; dotTemp?: boolean; encoding?: BufferEncoding; process?: boolean }): void;
export function withAmbientTenant<T>(tenantDir: string, fn: () => T): T;
export function ambientTenantDir(): string;
export const SCAN_SKIPPED: readonly string[];
export interface ReadCheckOpts { shipped?: string[]; kind?: 'file' | 'any' }
export function ownReadProblem(tenantDir: string, path: string, opts?: ReadCheckOpts): string;
export function ownOpenRead(tenantDir: string, path: string, opts?: ReadCheckOpts): { fd: number; stat: import('node:fs').Stats };
export function ownReadFile(tenantDir: string, path: string, opts?: ReadCheckOpts & { encoding?: BufferEncoding }): Buffer | string;
export function ownReadDir(tenantDir: string, path: string, opts?: ReadCheckOpts & { options?: { withFileTypes?: boolean } }): string[] | import('node:fs').Dirent[];
export function ownStat(tenantDir: string, path: string, opts?: ReadCheckOpts): import('node:fs').Stats;
export function ownTouches(tenantDir: string, path: string): boolean;
export const scanStats: { full: number; quick: number; only: number };
export function withScanMemo<T>(fn: () => T): T;
export const OWNED_PATH_SCALARS: readonly string[];
export const SHIPPED_PATH_SCALARS: readonly string[];
export const OWNED_PATH_LISTS: readonly string[];
export function namedPathInsideTenant(dir: string, p: string): boolean;
