/**
 * Shared contracts for the whole pipeline.
 *
 * Every module in `src/` imports its vocabulary from here and nowhere else, so the
 * stages (collect → fan-out → cluster → verify → score → render → publish) can be
 * developed and tested against each other without circular imports.
 */

import type { QaConfig } from './qa/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

/** Which deduplicated findings make it into the published review. */
export type PublishMode = 'all' | 'consensus';

export const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2', 'P3'] as const;

export type Category =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'api-contract'
  | 'concurrency'
  | 'convention'
  | 'test-gap';

export const CATEGORIES: readonly Category[] = [
  'correctness',
  'security',
  'performance',
  'api-contract',
  'concurrency',
  'convention',
  'test-gap',
] as const;

/**
 * One independently actionable defect, split into the four facts deduplication needs.
 *
 * Older/custom reviewers may omit this object; Juror then falls back to the human-facing
 * title/body and sends any possible duplicate to the referee instead of merging it locally.
 */
export interface FindingClaim {
  /** The concrete input, state, or event that reaches the defect. */
  trigger: string;
  /** The faulty code path or contract that produces the failure. */
  mechanism: string;
  /** The externally observable wrong result. */
  consequence: string;
  /** The independently actionable code change that resolves this defect. */
  fix: string;
}

/** A finding exactly as a model emitted it, after schema validation but before anchoring. */
export interface RawFinding {
  path: string;
  line: number;
  end_line: number | null;
  severity: Severity;
  title: string;
  body: string;
  category: Category;
  confidence: number;
  convention: string | null;
  /** Structured causal fingerprint used for conservative semantic deduplication. */
  claim?: FindingClaim;
}

/** A finding tagged with which model produced it and how anchoring resolved it. */
export interface AttributedFinding extends RawFinding {
  /** Stable within one review run; unlike title text, this cannot collide after rewriting. */
  sourceId: string;
  /** Config `id` of the model that raised this (e.g. `claude-opus-5`). */
  modelId: string;
  /** Display label for the model (e.g. `Opus 5`). */
  modelLabel: string;
  /** Line after snapping to the diff; equals `line` when the model anchored exactly. */
  anchoredLine: number;
  /** How the anchor was resolved. */
  anchor: AnchorStatus;
  /** Distance in lines between the model's claim and the nearest valid diff line. */
  anchorDrift: number;
}

export type AnchorStatus =
  /** `(path, line)` is an added/modified line in the diff. */
  | 'exact'
  /** Snapped to the nearest added/modified line within the tolerance window. */
  | 'snapped'
  /** Path is in the diff but the line is not near any change — reported, not posted inline. */
  | 'outside-diff'
  /** Path is not in the diff at all. */
  | 'unknown-file';

// ─────────────────────────────────────────────────────────────────────────────
// What a model returns
// ─────────────────────────────────────────────────────────────────────────────

export interface FileOverview {
  path: string;
  overview: string;
}

/** The JSON contract we ask each reviewing model to write to `$SCRATCH/findings.json`. */
export interface ModelReport {
  merge_confidence: number;
  confidence_reason: string;
  summary: string;
  highlights: string[];
  file_overviews: FileOverview[];
  /** Callback chains inspected during the mandatory async-contract pass. */
  async_contracts: string[];
  sequence_diagram: string | null;
  findings: RawFinding[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage & cost
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalized token usage. `uncachedIn` NEVER includes cached tokens — several
 * providers report a superset, and the adapter is responsible for subtracting.
 * See `src/harness/codex.ts` for the case that motivates this.
 */
export interface CanonicalUsage {
  uncachedIn: number;
  cacheRead: number;
  cacheWrite: number;
  out: number;
}

export const ZERO_USAGE: CanonicalUsage = { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0 };

/** Whether a dollar figure came from the provider or from our own arithmetic. */
export type CostSource = 'reported' | 'estimated' | 'unknown';

export interface CostBreakdown {
  usd: number | null;
  source: CostSource;
  /** True when this amount is only a known subtotal because one or more calls were unpriced. */
  partial?: boolean;
  /** True when the long-context tier repriced the request. */
  longContext: boolean;
  /** Human-readable note, surfaced in the receipt when something is unusual. */
  note?: string;
}

export interface PricingTier {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok?: number;
  cache_write_per_mtok?: number;
}

export interface PricingEntry extends PricingTier {
  context_window?: number;
  cache_min_prefix_tokens?: number;
  long_context?: PricingTier & { threshold_input_tokens: number; applies_to: 'entire_request' };
  source?: string;
  updated?: string;
  /** Original provider currency when Juror's USD estimate uses a recorded FX rate. */
  currency?: string;
  usd_conversion_rate?: number;
  conversion_source?: string;
}

export type PricingTable = Record<string, PricingEntry>;

// ─────────────────────────────────────────────────────────────────────────────
// Harness adapters
// ─────────────────────────────────────────────────────────────────────────────

export type HarnessId =
  | 'claude-code'
  | 'codex'
  | 'grok-build'
  | 'kimi-code'
  | 'deepseek'
  | 'opencode'
  | 'generic-openai';

/** Everything an adapter needs to build its command line. */
export interface RunContext {
  /** Absolute path to the repository checkout the agent may read. */
  repoDir: string;
  /** Absolute path to a per-model scratch directory the agent may write to. */
  scratchDir: string;
  /** Absolute path of the file the agent must write its report to. */
  findingsPath: string;
  /** Absolute path to the rendered review prompt on disk. */
  promptPath: string;
  /** The rendered review prompt text. */
  prompt: string;
  /** Model id as the harness expects it on the command line. */
  model: string;
  /** Optional OpenAI-compatible endpoint override from the model config. */
  baseUrl?: string;
  /** Extra per-model knobs from `.juror.yml` (`args:`). */
  args: Record<string, unknown>;
  /** Env for the child process. Contains only this model's provider key. */
  env: Record<string, string>;
  /** Provider credential value, independent of the configured env-var name. */
  providerKey?: string;
  /** Hard wall-clock limit for the child process. */
  timeoutMs: number;
  /** Per-model USD ceiling, when the harness can enforce one. */
  budgetUsd: number | null;
  /** Maximum agent turns. Zero disables the step cap; the wall-clock timeout still applies. */
  maxTurns: number;
}

export interface HarnessResult {
  /** Parsed report, or null when the agent produced nothing usable. */
  report: ModelReport | null;
  usage: CanonicalUsage | null;
  /** Provider-computed cost. `null` means we must estimate from tokens. */
  reportedCostUsd: number | null;
  /** Actual model identity returned by a routing provider, when available. */
  resolvedModel?: string;
  /** Where normalized token counts came from. */
  usageSource?: 'provider' | 'harness';
  turns: number;
  truncated: boolean;
  /** Final assistant text, kept for debugging and fenced-block fallback parsing. */
  rawText: string;
  /** Non-fatal notes worth surfacing (warnings, denied permissions, retries). */
  diagnostics: string[];
}

export interface Harness {
  id: HarnessId;
  /** Human label for the receipt table. */
  label: string;
  /** Resolve the binary, assert its version, and return the absolute path. */
  locate(env?: Record<string, string | undefined>): Promise<HarnessLocation>;
  /** Build the child process invocation. */
  command(ctx: RunContext): HarnessCommand;
  /** Turn raw child output into a normalized result. */
  parse(io: HarnessIO, ctx: RunContext): HarnessResult;
  /** Remove adapter-owned runtime state after every outcome, including spawn failures. */
  cleanup?(ctx: RunContext): void | Promise<void>;
}

export interface HarnessLocation {
  binPath: string;
  version: string;
  /** Adapter-specific warnings, e.g. a version older than the pin. */
  warnings: string[];
}

export interface HarnessCommand {
  argv: string[];
  env: Record<string, string>;
  /** Written to the child's stdin. Always set — even to '' — so no child blocks on a tty. */
  stdin: string;
  cwd: string;
}

export interface HarnessIO {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

/** One model's complete contribution to a review. */
export interface ModelRun {
  modelId: string;
  modelLabel: string;
  harness: HarnessId;
  harnessLabel: string;
  /** Pricing key — how this model is named in `pricing.json`. */
  pricingKey: string;
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  result: HarnessResult | null;
  cost: CostBreakdown;
  durationMs: number;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  path: string;
  /** Previous path for renames. */
  previousPath: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /**
   * Every line number in the post-image that the diff adds or modifies, sorted.
   * This is the set a finding must anchor to.
   */
  changedLines: number[];
  /** `newLine → position` in the unified patch, for GitHub inline comments. */
  positionByLine: Map<number, number>;
  /** True when the file was excluded by `review.paths_ignore`. */
  ignored: boolean;
}

export interface DiffContext {
  /** Unified patch text, already filtered by `paths_ignore`. */
  patch: string;
  files: DiffFile[];
  baseSha: string;
  headSha: string;
  /** Present when this is an incremental re-review. */
  sinceSha: string | null;
  totalAdditions: number;
  totalDeletions: number;
  /** Files dropped by `paths_ignore`, for the receipt. */
  ignoredPaths: string[];
  /** True when the patch was truncated to fit `review.max_diff_bytes`. */
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consensus
// ─────────────────────────────────────────────────────────────────────────────

export interface Cluster {
  id: string;
  path: string;
  line: number;
  endLine: number | null;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  convention: string | null;
  /** Distinct models that raised this. */
  modelIds: string[];
  modelLabels: string[];
  agreement: number;
  /** Every finding merged into this cluster. */
  members: AttributedFinding[];
  anchor: AnchorStatus;
  maxConfidence: number;
  /** How the merge happened, for `--explain`. */
  mergedBy: ('exact' | 'jaccard' | 'referee' | 'singleton')[];
  verification: Verification | null;
  published: boolean;
  /** Why this cluster was suppressed, when it was. */
  suppressedReason: string | null;
}

export interface Verification {
  refuted: boolean;
  reason: string;
  /** Model that ran the refutation pass. */
  byModel: string;
  cost: CostBreakdown;
}

export interface FindingDisposition {
  sourceId: string;
  modelId: string;
  modelLabel: string;
  path: string;
  line: number;
  title: string;
  clusterId: string;
  outcome: 'published' | 'suppressed';
  /** Always present for a suppression; null for a published finding. */
  reason: string | null;
}

/** Post-merge proof that every raw model finding reached a visible final outcome. */
export interface FindingCoverage {
  complete: boolean;
  rawFindings: number;
  accountedFor: number;
  uniqueFindings: number;
  dispositions: FindingDisposition[];
  /** Empty on success; populated when Juror had to fall back to lossless singletons. */
  problems: string[];
}

export interface Verdict {
  /** Median of the models' self-reported merge confidence. */
  base: number;
  penalty: number;
  score: number;
  votes: { modelLabel: string; vote: number }[];
  confirmed: Record<Severity, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelConfig {
  id: string;
  harness: HarnessId;
  enabled: boolean;
  /** Env var holding this model's provider key. */
  secret: string;
  /** Display label; defaults to a prettified `id`. */
  label?: string;
  /** Model string passed to the harness, when it differs from `id`. */
  harness_model?: string;
  /** Key into `pricing.json`, when it differs from `id`. */
  pricing_key?: string;
  base_url?: string;
  args?: Record<string, unknown>;
  timeout_seconds?: number;
  max_turns?: number;
}

export type ReviewPreset = 'starter' | 'fast' | 'balanced' | 'high' | 'ultra';

export interface JurorConfig {
  version: 1;
  /** Built-in jury selection, or null when an explicit `models:` list is active. */
  preset: ReviewPreset | null;
  models: ModelConfig[];
  consensus: {
    min_agreement: 'majority' | 'all' | number;
    verify_solo_findings: boolean;
    verify_model: string | null;
    referee_model: string | null;
    jaccard_merge_threshold: number;
    jaccard_distinct_threshold: number;
    line_window: number;
  };
  review: {
    publish_mode: PublishMode;
    severity_floor: Severity;
    max_inline_comments: number;
    paths_ignore: string[];
    anchor_tolerance: number;
    max_diff_bytes: number;
    per_model_timeout_seconds: number;
    /** Zero means unlimited; `per_model_timeout_seconds` remains the hard boundary. */
    max_turns: number;
  };
  budget: {
    /** Planning target, not a provider-enforced hard ceiling. */
    target_cost_usd_per_pr: number;
    on_exceed: 'partial' | 'skip';
  };
  output: {
    sequence_diagram: boolean;
    cost_receipt: boolean;
    suppressed_findings: 'collapsed' | 'hidden' | 'inline';
  };
  /** Opt-in post-merge browser QA. Disabled by default. */
  qa: QaConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// The finished review
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewResult {
  diff: DiffContext;
  runs: ModelRun[];
  clusters: Cluster[];
  published: Cluster[];
  suppressed: Cluster[];
  coverage: FindingCoverage;
  verdict: Verdict;
  summary: ReviewSummary;
  totals: CostTotals;
  /** Wall-clock for the whole review. */
  durationMs: number;
  /** Everything that went sideways but did not stop the review. */
  warnings: string[];
}

export interface ReviewSummary {
  summary: string;
  highlights: string[];
  fileOverviews: FileOverview[];
  sequenceDiagram: string | null;
  confidenceReason: string;
}

export interface CostRow {
  label: string;
  /** Actual provider-returned model identity, when it differs from the display label. */
  modelRef?: string;
  harnessLabel: string;
  usage: CanonicalUsage | null;
  usageSource?: 'provider' | 'harness';
  cost: CostBreakdown;
}

export interface CostTotals {
  rows: CostRow[];
  usage: CanonicalUsage;
  usd: number | null;
  /** True when at least one row is `unknown`, making the total a lower bound. */
  partial: boolean;
  modelsRun: number;
}
