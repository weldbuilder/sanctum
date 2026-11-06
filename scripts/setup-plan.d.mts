// Types for scripts/setup-plan.mjs, the setup wizard's questions, as the backend's /api/setup routes use them.

export type StepKind = 'text' | 'yesno' | 'choice' | 'multichoice' | 'secret';
export interface StepOption { value: string; label: string; detail?: string; on?: boolean }

/** A step of the plan. Dynamic parts are values or functions of the answers so far. */
export interface PlanStep {
  id: string;
  kind: StepKind;
  section?: string;
  question: string | ((answers: Record<string, any>) => string);
  help?: string[] | ((answers: Record<string, any>) => string[]);
  default?: unknown;
  options?: StepOption[] | ((answers: Record<string, any>) => StepOption[]);
  when?: (answers: Record<string, any>) => boolean;
  validate?: (value: any, answers: Record<string, any>) => string;
  [key: string]: unknown;
}
export interface Plan extends Array<PlanStep> {
  readonly env: Record<string, any>;
  readonly existing: Record<string, any>;
  readonly shipped: { id: string; name: string }[];
  reset(): void;
  /** The phase this plan walks: 'one', 'more' or 'all'. */
  readonly mode: 'one' | 'more' | 'all';
}

/** One step as the browser gets it. A secret carries only `saved`. */
export interface PublicStep {
  id: string;
  kind: StepKind;
  section?: string;
  question: string;
  help: string[];
  default?: unknown;
  saved?: boolean;
  options?: StepOption[];
  meta?: { pluginId: string; digest: string; files?: string[]; changes?: { kind: string; path: string }[]; kind: string };
  retry?: boolean;
  /** 1 = asked on a first run, 2 = behind `more`. */
  phase?: 1 | 2;
}
export interface Problem { id: string; message: string }
export interface Row { step: PlanStep; active: boolean; resolved?: Record<string, any>; value?: unknown; otherwise?: string[]; problem?: string }
export type SetupAnswers = Record<string, any>;

export const STEP_KINDS: readonly StepKind[];
/** The step ids asked on a first run (phase one), in order. */
export const PHASE_ONE: readonly string[];
export function setupPlan(existingConfig: Record<string, any>, env?: Record<string, any>): Plan;
export function walkValues(plan: Plan, sent?: Record<string, unknown>): { values: Record<string, any>; rows: Row[]; problems: Problem[]; skippedSent: string[] };
export function describePlan(plan: Plan, sent?: Record<string, unknown>): { steps: PublicStep[]; notes: string[]; problems: Problem[] };
export function buildAnswers(values: Record<string, any>, plan: Plan, opts?: { skipLedger?: boolean }): SetupAnswers;
export function checkKind(step: PlanStep, resolved: Record<string, any>, raw: unknown): { value?: unknown; error?: string };
