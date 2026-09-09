import { describe, expect, it } from 'vitest';
import { anyReviewPresetReady, missingProviderSecrets, qaProviderReady, reviewPresetReadiness } from '../worker/providers';
import type { Env } from '../worker/env';

const env = (secrets: Partial<Record<string, string>>) => secrets as unknown as Env;

describe('hosted provider readiness', () => {
  it('names only the credentials the configured preset is missing', () => {
    expect(missingProviderSecrets(env({ OPENAI_API_KEY: 'sk-test' }), 'review', 'fast')).toEqual(['FIREWORKS_API_KEY']);
    expect(missingProviderSecrets(env({ OPENAI_API_KEY: 'sk-test', FIREWORKS_API_KEY: 'fw-test' }), 'review', 'fast')).toEqual([]);
    expect(missingProviderSecrets(env({}), 'review', 'starter')).toEqual(['OPENROUTER_API_KEY']);
  });

  it('does not accept a key that belongs to a different preset', () => {
    // The runner starts the jury named by `--preset`, so an OpenRouter key cannot stand in
    // for the direct OpenAI and Fireworks routes the fast jury dials.
    const openrouterOnly = env({ OPENROUTER_API_KEY: 'or-test' });
    expect(missingProviderSecrets(openrouterOnly, 'review', 'fast')).toEqual(['OPENAI_API_KEY', 'FIREWORKS_API_KEY']);
    expect(reviewPresetReadiness(openrouterOnly)).toEqual({ starter: true, fast: false, balanced: false, high: false, ultra: false });
    expect(anyReviewPresetReady(openrouterOnly)).toBe(true);
  });

  it('treats blank and whitespace-only secrets as unset', () => {
    expect(missingProviderSecrets(env({ OPENROUTER_API_KEY: '' }), 'review', 'starter')).toEqual(['OPENROUTER_API_KEY']);
    expect(missingProviderSecrets(env({ OPENROUTER_API_KEY: '   ' }), 'review', 'starter')).toEqual(['OPENROUTER_API_KEY']);
  });

  it('does not advertise example placeholders as runnable credentials', () => {
    expect(missingProviderSecrets(env({ OPENROUTER_API_KEY: 'replace-me' }), 'review', 'starter')).toEqual(['OPENROUTER_API_KEY']);
    expect(missingProviderSecrets(env({ OPENAI_API_KEY: 'replace_before_deploy', FIREWORKS_API_KEY: 'fw-test' }), 'review', 'fast')).toEqual(['OPENAI_API_KEY']);
  });

  it('reports no preset ready when the deployment has no provider credential', () => {
    expect(anyReviewPresetReady(env({}))).toBe(false);
    expect(qaProviderReady(env({}))).toBe(false);
    expect(Object.values(reviewPresetReadiness(env({})))).toEqual([false, false, false, false, false]);
  });

  it('gates QA on the QA model provider regardless of the review preset', () => {
    expect(qaProviderReady(env({ OPENROUTER_API_KEY: 'or-test' }))).toBe(false);
    expect(qaProviderReady(env({ OPENAI_API_KEY: 'sk-test' }))).toBe(true);
    expect(missingProviderSecrets(env({ OPENROUTER_API_KEY: 'or-test' }), 'qa', 'starter')).toEqual(['OPENAI_API_KEY']);
  });

  it('fails closed on a preset it does not recognise', () => {
    const complete = env({ OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', XAI_API_KEY: 'c', FIREWORKS_API_KEY: 'd', OPENROUTER_API_KEY: 'e', SCW_SECRET_KEY: 'f' });
    expect(missingProviderSecrets(complete, 'review', 'nonexistent' as never)).toEqual(['UNKNOWN_REVIEW_PRESET']);
    expect(missingProviderSecrets(complete, 'review', 'ultra')).toEqual([]);
  });
});
