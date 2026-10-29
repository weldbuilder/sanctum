import { getDb } from './db.js';

// Anthropic public list prices (USD per million tokens) as of 2026-05.
// Source: anthropic.com/pricing. Keep this updated; users see cost estimates
// derived from it. Fall through to a conservative default if an unknown model
// shows up.
interface ModelPricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Fable tier — most capable widely released model (GA 2026-06-09). 1M ctx, 128k out.
  // Adaptive thinking is ALWAYS ON for Fable (no budget_tokens; effort defaults high).
  'claude-fable-5-1': { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cache_write: 12.5, cache_read: 1.0 },
  // Opus tier
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  'claude-opus-4-8[1m]': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-opus-4-8': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-opus-4-7': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-opus-4-6': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  // Sonnet tier
  // Sonnet 5 — introductory $2/$10 per MTok through 2026-08-31 (reverts to standard after; update then). 1M ctx, 128k out.
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  // Haiku tier
  // Haiku 5.5 — prompts up to 100K tokens; $0.50/$2.50 beyond that (not modelled here).
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
};

const FALLBACK_PRICING: ModelPricing = { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 };

export function estimateCostUsd(model: string, tokens: {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}): number {
  const price = PRICING[model] ?? FALLBACK_PRICING;
  return (
    (tokens.input * price.input) / 1_000_000 +
    (tokens.output * price.output) / 1_000_000 +
    (tokens.cache_creation * price.cache_write) / 1_000_000 +
    (tokens.cache_read * price.cache_read) / 1_000_000
  );
}

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function recordUsage(rec: UsageRecord): void {
  const cost = estimateCostUsd(rec.model, {
    input: rec.inputTokens,
    output: rec.outputTokens,
    cache_creation: rec.cacheCreationTokens,
    cache_read: rec.cacheReadTokens,
  });
  getDb().prepare(`
    INSERT INTO usage_log (occurred_at, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, est_cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    rec.model,
    rec.inputTokens,
    rec.outputTokens,
    rec.cacheCreationTokens,
    rec.cacheReadTokens,
    cost
  );
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  turns: number;
  windowDays: number;
  perDay: Array<{ date: string; tokens: number; cost: number }>;
  perModel: Array<{ model: string; turns: number; tokens: number; cost: number }>;
}

export function getUsageSummary(windowDays = 30): UsageSummary {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const totals = getDb().prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS in_t,
      COALESCE(SUM(output_tokens), 0) AS out_t,
      COALESCE(SUM(cache_creation_tokens), 0) AS cc_t,
      COALESCE(SUM(cache_read_tokens), 0) AS cr_t,
      COALESCE(SUM(est_cost_usd), 0) AS cost,
      COUNT(*) AS turns
    FROM usage_log
    WHERE occurred_at >= ?
  `).get(since) as { in_t: number; out_t: number; cc_t: number; cr_t: number; cost: number; turns: number };

  const perDay = getDb().prepare(`
    SELECT
      substr(occurred_at, 1, 10) AS date,
      SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
      SUM(est_cost_usd) AS cost
    FROM usage_log
    WHERE occurred_at >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(since) as Array<{ date: string; tokens: number; cost: number }>;

  const perModel = getDb().prepare(`
    SELECT
      model,
      COUNT(*) AS turns,
      SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens,
      SUM(est_cost_usd) AS cost
    FROM usage_log
    WHERE occurred_at >= ?
    GROUP BY model
    ORDER BY cost DESC
  `).all(since) as Array<{ model: string; turns: number; tokens: number; cost: number }>;

  return {
    totalInputTokens: totals.in_t,
    totalOutputTokens: totals.out_t,
    totalCacheCreationTokens: totals.cc_t,
    totalCacheReadTokens: totals.cr_t,
    totalCostUsd: totals.cost,
    turns: totals.turns,
    windowDays,
    perDay,
    perModel,
  };
}

export function clearUsageLog(): void {
  getDb().prepare('DELETE FROM usage_log').run();
}
