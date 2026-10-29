// Types for scripts/setup-apply.mjs: what the setup wizard reads and everything it writes.
import type { Plan, SetupAnswers } from './setup-plan.mjs';

export interface SetupEnv {
  root: string;
  homeDir: string;
  existing: Record<string, any>;
  yamlPath: string;
  hasConfigFile: boolean;
  envPath: string;
  envText: string;
  codexHome: string;
  tomlPath: string;
  tomlText: string;
  hasDatabase: boolean;
  discordToggle: string | null;
  savedPassword: string;
  mcpJsonPath: string;
  mcpJsonText: string;
  timezoneDefault: string;
  isCodexInstalled(): boolean;
  /** Tenant mode only: the tenant's folder and id, the operator's inherited base, the process timezone, and the harness and temp folders. */
  tenantDir?: string;
  tenantId?: string;
  inherited?: Record<string, any>;
  processTimezone?: string;
  tmpRoot?: string;
}
export interface GatherOptions {
  processEnv?: Record<string, string | undefined>;
  homeDir?: string;
  codexInstalled?: boolean;
  timezoneDefault?: string;
  discordToggle?: string | null;
  savedPassword?: string;
  /** Tenant mode: read and write this tenant's folder (and `operator`: ask for its hostname, as the terminal does). */
  tenantDir?: string;
  tenantId?: string;
  operator?: boolean;
}
export interface ApplyResult {
  wrote: string[];
  changed: { path: string; what: string }[];
  notes: string[];
  leftOut: string[];
  ratified: string[];
  restartNeeded: boolean;
  config: Record<string, any>;
}
export function configPathIn(root: string): string;
export function gatherSetupEnv(root: string, opts?: GatherOptions): SetupEnv;
export function backupFile(path: string, now?: () => string, mode?: number): string;
export function restartNeeded(before: Record<string, any>, after: Record<string, any>): boolean;
export function applySetup(answers: SetupAnswers, plan: Plan, io?: { say?: (line?: string) => void }, opts?: { writer?: string; backupConfig?: boolean; now?: () => string; check?: (tenantYaml: Record<string, any>) => string | null | undefined }): ApplyResult;
