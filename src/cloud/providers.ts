import type { ReviewPreset } from '../types.js';

/**
 * The provider credentials each hosted run actually needs.
 *
 * The hosted runner invokes the CLI with `--preset`, so the jury is fixed before the Sandbox
 * starts. Admitting a run because *some* provider key exists spends a Sandbox on a jury whose
 * every model answers 503 from the outbound handler, and reports an infrastructure failure
 * instead of a configuration one.
 *
 * This table is deliberately dependency-free so the Worker can import it without pulling the
 * CLI's filesystem and YAML loaders into the bundle. `test/cloud-providers.test.ts` proves it
 * still agrees with `builtinModelCatalog()`, so a preset cannot silently change its providers.
 */
export const PRESET_PROVIDER_SECRETS: Record<ReviewPreset, readonly string[]> = {
  starter: ['JUROR_OPENROUTER_API_KEY'],
  fast: ['JUROR_OPENAI_API_KEY', 'JUROR_FIREWORKS_API_KEY'],
  balanced: ['JUROR_OPENAI_API_KEY', 'JUROR_XAI_API_KEY', 'JUROR_FIREWORKS_API_KEY'],
  high: ['JUROR_OPENAI_API_KEY', 'JUROR_ANTHROPIC_API_KEY', 'JUROR_XAI_API_KEY'],
  ultra: [
    'JUROR_OPENAI_API_KEY',
    'JUROR_ANTHROPIC_API_KEY',
    'JUROR_XAI_API_KEY',
    'JUROR_FIREWORKS_API_KEY',
    'JUROR_SCALEWAY_API_KEY',
  ],
};

/** Hosted QA never overrides `qa.model`, so it always needs the default QA model's provider. */
export const QA_PROVIDER_SECRETS: readonly string[] = ['JUROR_OPENAI_API_KEY'];

/** Preset identifiers in escalation order, usable where importing the CLI config is too heavy. */
export const REVIEW_PRESET_IDS = Object.keys(PRESET_PROVIDER_SECRETS) as ReviewPreset[];

/** Credentials a run of this kind and preset needs. An unknown preset is never satisfiable. */
export function providerSecretsForRun(kind: 'review' | 'qa', preset: ReviewPreset): readonly string[] | null {
  if (kind === 'qa') return QA_PROVIDER_SECRETS;
  return PRESET_PROVIDER_SECRETS[preset] ?? null;
}
