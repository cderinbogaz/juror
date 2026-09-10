import { PRESET_PROVIDER_SECRETS, REVIEW_PRESET_IDS, providerSecretsForRun } from '../../src/cloud/providers';
import type { ReviewPreset } from '../../src/types';
import type { Env } from './env';

/**
 * Worker secret backing each runner credential. The mapping is written out rather than derived
 * by stripping the `JUROR_` prefix so a credential nobody wired up fails closed instead of
 * resolving to `undefined` and reading as configured.
 */
const WORKER_SECRET_FOR_RUNNER_SECRET: Readonly<Record<string, keyof Env>> = {
  JUROR_OPENAI_API_KEY: 'OPENAI_API_KEY',
  JUROR_ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  JUROR_XAI_API_KEY: 'XAI_API_KEY',
  JUROR_DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY',
  JUROR_FIREWORKS_API_KEY: 'FIREWORKS_API_KEY',
  JUROR_OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
  JUROR_SCALEWAY_API_KEY: 'SCW_SECRET_KEY',
  JUROR_MOONSHOT_API_KEY: 'MOONSHOT_API_KEY',
};

function configuredSecret(env: Env, workerSecret: keyof Env): boolean {
  const value = env[workerSecret];
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'replace-me' && normalized !== 'unconfigured' && !normalized.includes('replace_before_deploy');
}

/**
 * Worker secret names this run needs and the deployment does not have. An empty array means the
 * run can reach every model in its jury. These names are operator detail: log them, and keep
 * them out of customer-visible run events and the unauthenticated readiness response.
 */
export function missingProviderSecrets(env: Env, kind: 'review' | 'qa', preset: ReviewPreset): string[] {
  const required = providerSecretsForRun(kind, preset);
  if (!required) return ['UNKNOWN_REVIEW_PRESET'];
  const missing: string[] = [];
  for (const runnerSecret of required) {
    const workerSecret = WORKER_SECRET_FOR_RUNNER_SECRET[runnerSecret];
    if (!workerSecret) missing.push(runnerSecret);
    else if (!configuredSecret(env, workerSecret)) missing.push(workerSecret);
  }
  return missing;
}

/** Which review presets this deployment can actually run, for the operator readiness surface. */
export function reviewPresetReadiness(env: Env): Record<ReviewPreset, boolean> {
  const readiness = {} as Record<ReviewPreset, boolean>;
  for (const preset of REVIEW_PRESET_IDS) readiness[preset] = missingProviderSecrets(env, 'review', preset).length === 0;
  return readiness;
}

/** True when at least one preset is fully credentialed; a repository may still pick another. */
export function anyReviewPresetReady(env: Env): boolean {
  return REVIEW_PRESET_IDS.some((preset) => missingProviderSecrets(env, 'review', preset).length === 0);
}

export function qaProviderReady(env: Env): boolean {
  // Any preset works here: `missingProviderSecrets` ignores it for QA runs.
  return missingProviderSecrets(env, 'qa', 'fast').length === 0;
}

export { PRESET_PROVIDER_SECRETS, REVIEW_PRESET_IDS };
