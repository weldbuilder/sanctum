export const REQUIRED_BLOCKS: readonly string[];
export function parseFilterArgs(argv: unknown[]): { ok: boolean; blocked: Set<string>; workdir: string; cmd: string[]; problem: string };
export function filterArgs(entry: unknown): string[] | null;
export function entryHasFilter(entry: unknown): boolean;
export function browserEntryProblem(entry: unknown): 'unfiltered' | 'outdated' | null;
