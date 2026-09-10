import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeCost, loadPricing, totalCost } from '../src/cost/compute.js';
import { loadRolling, recordSpend } from '../src/cost/rolling.js';
import type { CanonicalUsage, CostBreakdown, HarnessResult, ModelRun } from '../src/types.js';

const pricing = loadPricing();

function usage(u: Partial<CanonicalUsage>): CanonicalUsage {
  return { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0, ...u };
}

function run(over: Partial<ModelRun>): ModelRun {
  return {
    modelId: 'claude-opus-5',
    modelLabel: 'Opus 5',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    pricingKey: 'claude-opus-5',
    ok: true,
    skipped: false,
    skipReason: null,
    result: null,
    cost: { usd: 0, source: 'estimated', longContext: false },
    durationMs: 1000,
    error: null,
    ...over,
  };
}

function result(u: CanonicalUsage | null): HarnessResult {
  return {
    report: null,
    usage: u,
    reportedCostUsd: null,
    turns: 1,
    truncated: false,
    rawText: '',
    diagnostics: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// pricing.json itself
// ─────────────────────────────────────────────────────────────────────────────

describe('pricing.json', () => {
  it('loads from the module directory, not the cwd', () => {
    expect(Object.keys(pricing).length).toBeGreaterThan(0);
    expect(pricing['gpt-5.6-sol']?.input_per_mtok).toBe(5.0);
    expect(pricing['gpt-5.6-terra']?.input_per_mtok).toBe(2.5);
    expect(pricing['gpt-5.6-terra']?.long_context?.output_per_mtok).toBe(22.5);
    expect(pricing['claude-opus-5']?.cache_write_per_mtok).toBe(6.25);
    expect(pricing['accounts/fireworks/models/deepseek-v4-flash-0731']?.input_per_mtok).toBe(0.14);
    expect(pricing['scaleway/deepseek-v4-flash-0731']).toMatchObject({
      input_per_mtok: 0.46456,
      cache_read_per_mtok: 0.092912,
      output_per_mtok: 0.92912,
      currency: 'EUR',
      usd_conversion_rate: 1.1614,
    });
    expect(pricing['openrouter/openai/gpt-5.6-luna-20260709']).toMatchObject({
      input_per_mtok: 0.1,
      cache_read_per_mtok: 0.01,
      output_per_mtok: 0.6,
    });
    expect(pricing['openrouter/deepseek/deepseek-v4-flash-20260731']).toMatchObject({
      input_per_mtok: 0.08,
      cache_read_per_mtok: 0.016,
      output_per_mtok: 0.18,
    });
    expect(pricing['accounts/fireworks/models/kimi-k3']).toMatchObject({
      input_per_mtok: 3,
      cache_read_per_mtok: 0.3,
      output_per_mtok: 15,
    });
  });

  it('drops the $meta block instead of exposing it as a model', () => {
    expect(pricing['$meta']).toBeUndefined();
    expect(Object.keys(pricing).some((k) => k.startsWith('$'))).toBe(false);
  });

  it('carries a source and a date on every entry — stale prices are the failure mode', () => {
    for (const [key, entry] of Object.entries(pricing)) {
      expect(entry.source, `${key} source`).toMatch(/^https?:\/\//);
      expect(entry.updated, `${key} updated`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.input_per_mtok, `${key} input`).toBeGreaterThan(0);
      expect(entry.output_per_mtok, `${key} output`).toBeGreaterThan(0);
    }
  });

  // loadPricing() strips $-prefixed keys, so this invariant has to read the raw file.
  it("$meta.updated is never older than the newest model entry's updated date", () => {
    const rawPath = join(dirname(fileURLToPath(import.meta.url)), '../src/cost/pricing.json');
    const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as {
      $meta: { updated: string };
      models: Record<string, { updated?: string }>;
    };
    expect(raw.$meta.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const entryDates = Object.entries(raw.models).map(([key, entry]) => {
      expect(entry.updated, `${key} updated`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      return entry.updated as string;
    });
    const newest = entryDates.reduce((a, b) => (a >= b ? a : b));
    expect(
      raw.$meta.updated >= newest,
      `$meta.updated ${raw.$meta.updated} is older than newest entry ${newest}`,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeCost — SPEC rules 1..5
// ─────────────────────────────────────────────────────────────────────────────

describe('computeCost rule 1 — reported wins', () => {
  it('returns the provider figure verbatim and does no arithmetic', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: usage({ uncachedIn: 500_000, out: 100_000 }), // would estimate to $5.00
      reportedCostUsd: 0.9712,
      pricing,
    });
    expect(cost).toEqual({ usd: 0.9712, source: 'reported', longContext: false });
  });

  it('reports even when the pricing key is unknown', () => {
    const cost = computeCost({
      pricingKey: 'no-such-model',
      usage: null,
      reportedCostUsd: 0.25,
      pricing,
    });
    expect(cost.usd).toBe(0.25);
    expect(cost.source).toBe('reported');
  });
});

describe('computeCost rule 2 — never guess', () => {
  it('is unknown with neither usage nor a reported cost', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: null,
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBeNull();
    expect(cost.source).toBe('unknown');
  });

  it('uses the pinned OpenRouter rate only when provider-charged cost is absent', () => {
    const cost = computeCost({
      pricingKey: 'openrouter/deepseek/deepseek-v4-flash-20260731',
      usage: usage({ uncachedIn: 1_000_000, cacheRead: 500_000, out: 1_000_000 }),
      reportedCostUsd: null,
      pricing,
      turns: 2,
    });

    expect(cost).toMatchObject({ usd: 0.268, source: 'estimated', longContext: false });
  });
});

describe('computeCost rule 3b — the cliff is per request, not per session', () => {
  // Verbatim usage from a real Codex review of a 239-line diff in a large monorepo
  // (textcortex/platform#10333, 2026-08-06). Summing a cliff test over ~40 agent turns
  // priced the whole session at the long-context rate and reported $5.32 for what is
  // actually a $2.76 review.
  const REAL_SESSION = {
    uncachedIn: 165_228,
    cacheRead: 3_113_728,
    cacheWrite: 0,
    out: 12_412,
  };
  const STANDARD_TIER_USD = 2.755_4; // 165228*5 + 3113728*0.50 + 12412*30, per Mtok

  it('reports aggregate multi-turn pricing as a standard-tier lower bound', () => {
    const cost = computeCost({
      pricingKey: 'gpt-5.6-sol',
      usage: REAL_SESSION,
      reportedCostUsd: null,
      pricing,
      turns: 40,
    });
    expect(cost.longContext).toBe(false);
    expect(cost.usd).toBeCloseTo(STANDARD_TIER_USD, 3);
    expect(cost.partial).toBe(true);
    expect(cost.note).toContain('lower bound');
  });

  it('refuses the cliff when the total alone exceeds the context window', () => {
    // Even with no turn count, 3.28M input cannot have been one request against a 1.05M
    // window, so the aggregate is provably cumulative.
    const cost = computeCost({
      pricingKey: 'gpt-5.6-sol',
      usage: REAL_SESSION,
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.longContext).toBe(false);
    expect(cost.usd).toBeCloseTo(STANDARD_TIER_USD, 3);
    expect(cost.partial).toBe(true);
  });

  it('does not infer every request from an above-threshold average', () => {
    // An average of 300k is compatible with many different per-request distributions.
    const cost = computeCost({
      pricingKey: 'gpt-5.6-sol',
      usage: { uncachedIn: 1_200_000, cacheRead: 0, cacheWrite: 0, out: 4_000 },
      reportedCostUsd: null,
      pricing,
      turns: 4,
    });
    expect(cost.longContext).toBe(false);
    expect(cost.partial).toBe(true);
    // Known standard-tier lower bound: 1_200_000 * $5/Mtok + 4_000 * $30/Mtok.
    expect(cost.usd).toBeCloseTo(6.12, 4);
  });

  it('applies the cliff exactly when usage belongs to one request', () => {
    const cost = computeCost({
      pricingKey: 'gpt-5.6-sol',
      usage: { uncachedIn: 300_000, cacheRead: 0, cacheWrite: 0, out: 1_000 },
      reportedCostUsd: null,
      pricing,
      turns: 1,
    });
    expect(cost.longContext).toBe(true);
    expect(cost.partial).not.toBe(true);
    expect(cost.usd).toBeCloseTo(3.045, 4);
  });

  it('never turns a session estimate into a credit or a zero', () => {
    const cost = computeCost({
      pricingKey: 'gpt-5.6-sol',
      usage: REAL_SESSION,
      reportedCostUsd: null,
      pricing,
      turns: 40,
    });
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost.source).toBe('estimated');
  });
});

describe('computeCost rule 3 — the long-context cliff', () => {
  const key = 'gpt-5.6-sol';

  it('prices 271_999 total input at the standard tier', () => {
    const cost = computeCost({
      pricingKey: key,
      usage: usage({ uncachedIn: 271_999, out: 1_000 }),
      reportedCostUsd: null,
      pricing,
    });
    // 271_999 * $5/Mtok + 1_000 * $30/Mtok
    expect(cost.usd).toBe(1.389995);
    expect(cost.source).toBe('estimated');
    expect(cost.longContext).toBe(false);
  });

  it('reprices the ENTIRE request at 272_001 total input, not just the excess', () => {
    const cost = computeCost({
      pricingKey: key,
      usage: usage({ uncachedIn: 272_001, out: 1_000 }),
      reportedCostUsd: null,
      pricing,
    });
    // 272_001 * $10/Mtok + 1_000 * $45/Mtok — every token at the long rate.
    expect(cost.usd).toBe(2.76501);
    expect(cost.longContext).toBe(true);
    // Not the "slope" reading, which would only surcharge the 1 token over the line.
    expect(cost.usd).not.toBeCloseTo(1.39001, 5);
  });

  it('counts cache reads and writes toward the threshold and reprices them too', () => {
    const below = computeCost({
      pricingKey: key,
      usage: usage({ uncachedIn: 199_999, cacheRead: 60_000, cacheWrite: 12_000, out: 1_000 }),
      reportedCostUsd: null,
      pricing,
    });
    // 199_999*5 + 60_000*0.50 + 12_000*6.25 + 1_000*30, per Mtok
    expect(below.usd).toBe(1.134995);
    expect(below.longContext).toBe(false);

    const above = computeCost({
      pricingKey: key,
      usage: usage({ uncachedIn: 200_001, cacheRead: 60_000, cacheWrite: 12_000, out: 1_000 }),
      reportedCostUsd: null,
      pricing,
    });
    // total input 272_001 → 200_001*10 + 60_000*1.00 + 12_000*12.50 + 1_000*45
    expect(above.usd).toBe(2.25501);
    expect(above.longContext).toBe(true);
    expect(above.note).toContain('long-context');
  });

  it('applies grok 4.5 own 200k cliff', () => {
    const below = computeCost({
      pricingKey: 'grok-4.5',
      usage: usage({ uncachedIn: 199_999, out: 10_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(below.usd).toBe(0.459998); // 199_999*2 + 10_000*6, per Mtok
    expect(below.longContext).toBe(false);

    const above = computeCost({
      pricingKey: 'grok-4.5',
      usage: usage({ uncachedIn: 200_001, out: 10_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(above.usd).toBe(0.920004); // 200_001*4 + 10_000*12 — roughly double, as designed
    expect(above.longContext).toBe(true);
  });
});

describe('computeCost rule 4 — cache writes are not free', () => {
  it('prices Kimi K3 from the checked-in Fireworks rates', () => {
    const cost = computeCost({
      pricingKey: 'accounts/fireworks/models/kimi-k3',
      usage: usage({ uncachedIn: 100_000, cacheRead: 50_000, out: 10_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBe(0.465); // 100k*$3 + 50k*$0.30 + 10k*$15, per Mtok
    expect(cost.source).toBe('estimated');
  });

  it('bills a write-only run', () => {
    const cost = computeCost({
      pricingKey: 'gpt-5.6-sol',
      usage: usage({ cacheWrite: 10_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBe(0.0625); // 10_000 * $6.25/Mtok
    expect(cost.usd).toBeGreaterThan(0);
  });

  it('falls back to the input rate when a provider publishes no write rate, and says so', () => {
    const cost = computeCost({
      pricingKey: 'grok-4.5',
      usage: usage({ cacheWrite: 10_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBe(0.02); // 10_000 * $2.00/Mtok (the input rate)
    expect(cost.note).toContain('cache-write');
  });

  it('bills cache reads at the read rate, well below input', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: usage({ cacheRead: 1_000_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBe(0.5);
  });
});

describe('computeCost rule 5 — unknown pricing key', () => {
  it('is unknown, not zero, when usage is present but the model is unpriced', () => {
    const cost = computeCost({
      pricingKey: 'gpt-9-imaginary',
      usage: usage({ uncachedIn: 100_000, out: 5_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBeNull();
    expect(cost.usd).not.toBe(0);
    expect(cost.source).toBe('unknown');
    expect(cost.note).toContain('gpt-9-imaginary');
  });
});

describe('computeCost hygiene', () => {
  it('never rounds a real sub-cent charge down to zero', () => {
    const cost = computeCost({
      pricingKey: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      usage: usage({ uncachedIn: 1 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost.usd).toBeLessThan(0.000001);
  });

  it('rounds away float noise', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: usage({ uncachedIn: 3, out: 7 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(String(cost.usd)).not.toMatch(/e-|0000000/);
  });

  it('clamps a negative token count instead of issuing a credit', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: usage({ uncachedIn: -50_000, out: 1_000 }),
      reportedCostUsd: null,
      pricing,
    });
    expect(cost.usd).toBe(0.025);
    expect(cost.note).toContain('clamped');
  });

  it('ignores an unusable reported figure rather than publishing it', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: usage({ uncachedIn: 1_000_000 }),
      reportedCostUsd: Number.NaN,
      pricing,
    });
    expect(cost.usd).toBe(5);
    expect(cost.source).toBe('estimated');
    expect(cost.note).toContain('reported cost');
  });

  it('treats an empty pricing table as unknown, never as free', () => {
    const cost = computeCost({
      pricingKey: 'claude-opus-5',
      usage: usage({ uncachedIn: 1_000_000 }),
      reportedCostUsd: null,
      pricing: {},
    });
    expect(cost.source).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// totalCost
// ─────────────────────────────────────────────────────────────────────────────

describe('totalCost', () => {
  const opus = run({
    result: result(usage({ uncachedIn: 100_000, cacheRead: 20_000, out: 5_000 })),
    cost: { usd: 0.6, source: 'reported', longContext: false },
  });
  const codex = run({
    modelId: 'gpt-5.6-sol',
    modelLabel: 'GPT-5.6 Sol',
    harness: 'codex',
    harnessLabel: 'Codex CLI',
    pricingKey: 'gpt-5.6-sol',
    result: result(usage({ uncachedIn: 90_000, cacheWrite: 10_000, out: 4_000 })),
    cost: { usd: 0.3, source: 'estimated', longContext: false },
  });

  it('sums usage componentwise and money across models plus extras', () => {
    const totals = totalCost([opus, codex], [
      {
        label: 'Referee',
        harnessLabel: 'Claude Code',
        usage: usage({ uncachedIn: 10_000, out: 1_000 }),
        cost: { usd: 0.07, source: 'reported', longContext: false },
      },
    ]);
    expect(totals.rows).toHaveLength(3);
    expect(totals.usage).toEqual({
      uncachedIn: 200_000,
      cacheRead: 20_000,
      cacheWrite: 10_000,
      out: 10_000,
    });
    expect(totals.usd).toBe(0.97);
    expect(totals.partial).toBe(false);
    expect(totals.modelsRun).toBe(2);
  });

  it('marks the total partial when any row is unknown', () => {
    const opaque = run({
      modelId: 'opaque-model',
      modelLabel: 'Opaque model',
      pricingKey: 'opaque-model',
      result: result(null),
      cost: { usd: null, source: 'unknown', longContext: false, note: 'no usage on stdout' },
    });
    const totals = totalCost([opus, opaque], []);
    expect(totals.partial).toBe(true);
    // Still a documented lower bound, not a fabricated whole.
    expect(totals.usd).toBe(0.6);
  });

  it('keeps an auxiliary known subtotal marked as partial', () => {
    const totals = totalCost([opus], [{
      label: 'verify',
      harnessLabel: 'Codex',
      usage: null,
      cost: {
        usd: 0.04,
        source: 'estimated',
        longContext: false,
        partial: true,
        note: 'one verification reported no usage',
      },
    }]);
    expect(totals.usd).toBe(0.64);
    expect(totals.partial).toBe(true);
  });

  it('keeps skipped models as rows without poisoning the total', () => {
    const skipped = run({
      modelId: 'grok-4.5',
      modelLabel: 'Grok 4.5',
      pricingKey: 'grok-4.5',
      ok: false,
      skipped: true,
      skipReason: 'XAI_API_KEY is not set',
      cost: { usd: null, source: 'unknown', longContext: false },
    });
    const totals = totalCost([opus, skipped], []);
    expect(totals.rows).toHaveLength(2);
    expect(totals.rows[1]?.cost.usd).toBe(0);
    expect(totals.rows[1]?.cost.note).toBe('XAI_API_KEY is not set');
    expect(totals.partial).toBe(false);
    expect(totals.modelsRun).toBe(1);
  });

  it('is unknown, not zero, when nothing at all could be priced', () => {
    const blind: CostBreakdown = { usd: null, source: 'unknown', longContext: false };
    const totals = totalCost([run({ cost: blind })], []);
    expect(totals.usd).toBeNull();
    expect(totals.partial).toBe(true);
  });

  it('is zero for an empty review rather than unknown', () => {
    expect(totalCost([], []).usd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rolling spend
// ─────────────────────────────────────────────────────────────────────────────

describe('rolling spend', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'juror-rolling-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('starts empty and never throws on a missing file', () => {
    const r = loadRolling(join(tmp(), 'does', 'not', 'exist'));
    expect(r).toEqual({ totalUsd: 0, prCount: 0, windowDays: 30, since: expect.any(String) });
  });

  it('accumulates across distinct PRs and persists', () => {
    const dir = tmp();
    recordSpend(dir, 0.97, 'owner/repo#1@aaa');
    const r = recordSpend(dir, 0.5, 'owner/repo#2@bbb');
    expect(r.totalUsd).toBe(1.47);
    expect(r.prCount).toBe(2);
    expect(loadRolling(dir)).toEqual(r);
  });

  it('de-duplicates by prKey so a re-review updates instead of double-counting', () => {
    const dir = tmp();
    recordSpend(dir, 0.97, 'owner/repo#1@aaa');
    const r = recordSpend(dir, 1.25, 'owner/repo#1@aaa');
    expect(r.totalUsd).toBe(1.25);
    expect(r.prCount).toBe(1);
  });

  it('records an unpriced review without counting it as a $0 PR', () => {
    const dir = tmp();
    recordSpend(dir, 0.4, 'owner/repo#1@aaa');
    const r = recordSpend(dir, null, 'owner/repo#2@bbb');
    expect(r.totalUsd).toBe(0.4);
    expect(r.prCount).toBe(1);
    // …and a later priced re-review of that same PR replaces the null entry.
    expect(recordSpend(dir, 0.6, 'owner/repo#2@bbb').prCount).toBe(2);
  });

  it('drops entries older than the window', () => {
    const dir = tmp();
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    writeFileSync(
      join(dir, 'rolling.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { prKey: 'stale', usd: 99, at: old },
          { prKey: 'fresh', usd: 1.5, at: new Date().toISOString() },
        ],
      }),
    );
    expect(loadRolling(dir)).toMatchObject({ totalUsd: 1.5, prCount: 1 });
  });

  it('starts fresh on a truncated file instead of throwing', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'rolling.json'), '{"version":1,"entries":[{"prKey":"a","usd":1');
    expect(loadRolling(dir).prCount).toBe(0);
    expect(recordSpend(dir, 0.25, 'owner/repo#3@ccc').totalUsd).toBe(0.25);
  });

  it('ignores malformed entries inside an otherwise valid file', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'rolling.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { prKey: 'ok', usd: 2, at: new Date().toISOString() },
          { prKey: '', usd: 3, at: new Date().toISOString() },
          { usd: 4, at: new Date().toISOString() },
          { prKey: 'bad-date', usd: 5, at: 'yesterday' },
          'nonsense',
        ],
      }),
    );
    expect(loadRolling(dir)).toMatchObject({ totalUsd: 2, prCount: 1 });
  });

  it('reaps a stale cross-process lock before updating the ledger', () => {
    const dir = tmp();
    const lock = join(dir, 'rolling.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), 'dead-process\n');
    const stale = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, stale, stale);

    const result = recordSpend(dir, 0.75, 'owner/repo#4@ddd');
    expect(result).toMatchObject({ totalUsd: 0.75, prCount: 1 });
    expect(loadRolling(dir)).toEqual(result);
  });
});
