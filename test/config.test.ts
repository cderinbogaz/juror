import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyReviewPreset,
  defaultConfig,
  loadConfig,
  loadConfigText,
  loadPromptTemplate,
  providerEnvFor,
  readSecret,
  renderTemplate,
  resolveModelRuntime,
} from '../src/config.js';

const dirs: string[] = [];

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'juror-config-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('defaultConfig', () => {
  it('defaults to the fast two-model jury', () => {
    const c = defaultConfig();
    expect(c.preset).toBe('fast');
    expect(c.review.publish_mode).toBe('all');
    expect(c.review.max_turns).toBe(0);
    expect(c.consensus.min_agreement).toBe('all');
    expect(c.models.map((m) => m.id)).toEqual(['gpt-5.6-luna', 'deepseek-v4-flash-0731']);
    expect(c.models[0]?.harness).toBe('codex');
    expect(c.models[0]?.secret).toBe('JUROR_OPENAI_API_KEY');
    expect(c.models[0]?.args?.['reasoning_effort']).toBe('low');
    expect(c.models[1]?.harness).toBe('deepseek');
    expect(c.models[1]?.secret).toBe('JUROR_FIREWORKS_API_KEY');
    expect(c.models[1]?.harness_model).toBe('accounts/fireworks/models/deepseek-v4-flash-0731');
    expect(c.models[1]?.pricing_key).toBe('accounts/fireworks/models/deepseek-v4-flash-0731');
    // CodeWhale 0.9.7 maps every non-max Fireworks reasoning tier to high.
    expect(c.models[1]?.args?.['reasoning_effort']).toBe('high');
    expect(c.consensus.verify_model).toBe('deepseek-v4-flash-0731');
    expect(c.consensus.referee_model).toBe('deepseek-v4-flash-0731');
    // Kept well clear of the jury's slowest legitimate run: Luna was measured at 750–900s
    // on large diffs at `max`, and is faster at `low`. This is a hung-harness kill switch,
    // so headroom costs nothing and a tight wall silently drops a model mid-review.
    expect(c.review.per_model_timeout_seconds).toBe(1800);
  });

  it('hands out an independent copy each call', () => {
    const a = defaultConfig();
    a.review.severity_floor = 'P0';
    a.review.paths_ignore.push('mutated/**');
    // Must differ from the default, or a shared reference would still read back as default.
    if (a.models[0]?.args) a.models[0].args['reasoning_effort'] = 'max';
    const b = defaultConfig();
    expect(b.review.severity_floor).toBe('P3');
    expect(b.review.paths_ignore).not.toContain('mutated/**');
    expect(b.models[0]?.args?.['reasoning_effort']).toBe('low');
  });

  it('ships the opt-in one-secret starter and the direct-provider presets', () => {
    const base = defaultConfig();
    const starter = applyReviewPreset(base, 'starter');
    const fast = applyReviewPreset(base, 'fast');
    const balanced = applyReviewPreset(base, 'balanced');
    const high = applyReviewPreset(base, 'high');
    const ultra = applyReviewPreset(base, 'ultra');

    expect(starter.models).toMatchObject([
      {
        id: 'openrouter-gpt-5.6-luna',
        harness: 'generic-openai',
        secret: 'JUROR_OPENROUTER_API_KEY',
        harness_model: 'openai/gpt-5.6-luna',
        base_url: 'https://openrouter.ai/api/v1',
      },
      {
        id: 'openrouter-deepseek-v4-flash',
        harness: 'generic-openai',
        secret: 'JUROR_OPENROUTER_API_KEY',
        harness_model: 'deepseek/deepseek-v4-flash-0731',
        base_url: 'https://openrouter.ai/api/v1',
      },
    ]);
    expect(starter.models.every((model) => model.args?.['usage_cost'] === 'usd')).toBe(true);
    expect(starter.consensus.referee_model).toBe('openrouter-deepseek-v4-flash');
    expect(fast.models.map((m) => m.id)).toEqual(['gpt-5.6-luna', 'deepseek-v4-flash-0731']);
    expect(fast.models.map((m) => m.args?.['reasoning_effort'] ?? m.args?.['variant'])).toEqual(['low', 'high']);
    expect(fast.consensus.referee_model).toBe('deepseek-v4-flash-0731');
    // No longer the default, so this is the only place its membership is pinned.
    expect(balanced.models.map((m) => m.id)).toEqual(['gpt-5.6-terra', 'grok-4.5', 'kimi-k3', 'glm-5p3', 'minimax-m3']);
    expect(balanced.models[0]?.args?.['reasoning_effort']).toBe('max');
    expect(balanced.models[1]?.args?.['reasoning_effort']).toBe('high');
    expect(balanced.consensus.referee_model).toBe('kimi-k3');
    expect(high.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'claude-opus-5', 'grok-4.5']);
    expect(high.consensus.referee_model).toBe('grok-4.5');
    expect(ultra.models.map((m) => m.id)).toEqual([
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'claude-opus-5',
      'grok-4.5',
      'kimi-k3',
      'deepseek-v4-flash-0731',
      'scaleway-deepseek-v4-flash-0731',
    ]);
    expect(ultra.consensus.referee_model).toBe('deepseek-v4-flash-0731');
  });

  it('ships DeepSeek V4 Flash on the dedicated Scaleway endpoint', () => {
    const scaleway = applyReviewPreset(defaultConfig(), 'ultra').models.find(
      (model) => model.id === 'scaleway-deepseek-v4-flash-0731',
    );

    expect(scaleway).toMatchObject({
      harness: 'generic-openai',
      secret: 'JUROR_SCALEWAY_API_KEY',
      base_url: 'https://api.scaleway.ai/v1',
      harness_model: 'deepseek-v4-flash-0731',
      pricing_key: 'scaleway/deepseek-v4-flash-0731',
      args: { reasoning_effort: 'high' },
    });
  });
});

describe('provider credentials', () => {
  it('prefers the prefixed name so Juror spend can be billed separately', () => {
    const env = { JUROR_OPENAI_API_KEY: 'dedicated', OPENAI_API_KEY: 'shared' };
    expect(readSecret(env, 'JUROR_OPENAI_API_KEY')).toEqual({
      value: 'dedicated',
      source: 'JUROR_OPENAI_API_KEY',
    });
  });

  // Without this every pre-1.3 install silently loses its whole jury on upgrade.
  it('falls back to the bare vendor name, and reports which one it read', () => {
    expect(readSecret({ OPENAI_API_KEY: 'shared' }, 'JUROR_OPENAI_API_KEY')).toEqual({
      value: 'shared',
      source: 'OPENAI_API_KEY',
    });
  });

  it('treats a blank or missing key as absent rather than as a value', () => {
    expect(readSecret({ JUROR_OPENAI_API_KEY: '   ' }, 'JUROR_OPENAI_API_KEY').value).toBeUndefined();
    expect(readSecret({}, 'JUROR_OPENAI_API_KEY').value).toBeUndefined();
    // A blank prefixed key must not shadow a real bare one.
    expect(readSecret({ JUROR_OPENAI_API_KEY: '', OPENAI_API_KEY: 'shared' }, 'JUROR_OPENAI_API_KEY').value).toBe(
      'shared',
    );
  });

  it('does not invent a fallback for a custom secret name', () => {
    expect(readSecret({ MY_KEY: 'k' }, 'MY_KEY').value).toBe('k');
    expect(readSecret({ KEY: 'k' }, 'MY_KEY').value).toBeUndefined();
  });

  // Claude Code, opencode and Grok read their own environment, so the name handed to the
  // child is fixed by the vendor. Renaming it there is an invisible 401, not a config error.
  it('hands every harness the vendor variable, never the prefixed one', () => {
    expect(providerEnvFor('claude-code')).toBe('ANTHROPIC_API_KEY');
    expect(providerEnvFor('codex')).toBe('OPENAI_API_KEY');
    expect(providerEnvFor('grok-build')).toBe('XAI_API_KEY');
    expect(providerEnvFor('kimi-code')).toBe('FIREWORKS_API_KEY');
    expect(providerEnvFor('deepseek')).toBe('FIREWORKS_API_KEY');
    expect(providerEnvFor('opencode')).toBe('FIREWORKS_API_KEY');
    expect(providerEnvFor('generic-openai')).toBe('OPENAI_API_KEY');
    for (const harness of ['claude-code', 'codex', 'grok-build', 'kimi-code', 'deepseek', 'opencode', 'generic-openai'] as const) {
      expect(providerEnvFor(harness).startsWith('JUROR_')).toBe(false);
    }
  });
});

describe('loadConfig', () => {
  it('returns the defaults with no problems when there is no config file', () => {
    const { config, problems, sourcePath } = loadConfig(repoWith({}));
    expect(sourcePath).toBeNull();
    expect(problems).toEqual([]);
    expect(config).toEqual(defaultConfig());
  });

  it('deep-merges the sections it finds and leaves the rest alone', () => {
    const dir = repoWith({
      '.juror.yml': ['review:', '  severity_floor: P1', '  max_inline_comments: 3', ''].join('\n'),
    });
    const { config, problems, sourcePath } = loadConfig(dir);
    expect(sourcePath).toBe(join(dir, '.juror.yml'));
    expect(problems).toEqual([]);
    expect(config.review.severity_floor).toBe('P1');
    expect(config.review.max_inline_comments).toBe(3);
    expect(config.review.paths_ignore).toEqual(defaultConfig().review.paths_ignore);
    expect(config.consensus).toEqual(defaultConfig().consensus);
  });

  it('finds .github/juror.yml when there is no root config', () => {
    const dir = repoWith({ '.github/juror.yml': 'budget:\n  target_cost_usd_per_pr: 5\n' });
    const { config, sourcePath } = loadConfig(dir);
    expect(sourcePath).toBe(join(dir, '.github/juror.yml'));
    expect(config.budget.target_cost_usd_per_pr).toBe(5);
  });

  it('parses trusted base-revision text without reading the working tree', () => {
    const loaded = loadConfigText('preset: fast\nreview:\n  publish_mode: consensus\n', '.juror.yml@base');
    expect(loaded.sourcePath).toBe('.juror.yml@base');
    expect(loaded.config.preset).toBe('fast');
    expect(loaded.config.review.publish_mode).toBe('consensus');
  });

  it('never forwards GitHub control-plane credentials to a model', () => {
    const loaded = loadConfigText(
      'models:\n  - id: custom\n    harness: generic-openai\n    secret: GITHUB_TOKEN\n',
      '.juror.yml@base',
    );
    expect(loaded.config.models[0]?.secret).toBe('JUROR_OPENAI_API_KEY');
    expect(loaded.problems.join('\n')).toContain('not permitted for a model process');
  });

  it('falls back to the default and reports a problem for a bad enum', () => {
    const dir = repoWith({
      '.juror.yml': [
        'review:',
        '  publish_mode: every',
        '  severity_floor: P9',
        'budget:',
        '  on_exceed: explode',
        'output:',
        '  suppressed_findings: sideways',
        'consensus:',
        '  min_agreement: most',
        '',
      ].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(config.review.publish_mode).toBe('all');
    expect(config.review.severity_floor).toBe('P3');
    expect(config.budget.on_exceed).toBe('partial');
    expect(config.output.suppressed_findings).toBe('collapsed');
    expect(config.consensus.min_agreement).toBe('all');
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toContain('review.publish_mode');
    expect(problems.join('\n')).toContain('review.severity_floor');
    expect(problems.join('\n')).toContain('budget.on_exceed');
    expect(problems.join('\n')).toContain('output.suppressed_findings');
    expect(problems.join('\n')).toContain('consensus.min_agreement');
  });

  it('accepts both publication modes', () => {
    const dir = repoWith({ '.juror.yml': 'review:\n  publish_mode: consensus\n' });
    const { config, problems } = loadConfig(dir);
    expect(config.review.publish_mode).toBe('consensus');
    expect(problems).toEqual([]);
  });

  it('accepts zero as an unlimited review and per-model turn cap', () => {
    const dir = repoWith({
      '.juror.yml': [
        'review:',
        '  max_turns: 0',
        'models:',
        '  - id: kimi-k3',
        '    harness: kimi-code',
        '    max_turns: 0',
        '',
      ].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(problems).toEqual([]);
    expect(config.review.max_turns).toBe(0);
    expect(config.models[0]?.max_turns).toBe(0);
  });

  it('selects a built-in preset before applying section overrides', () => {
    const dir = repoWith({
      '.juror.yml': 'preset: high\nconsensus:\n  referee_model: claude-opus-5\n',
    });
    const { config, problems } = loadConfig(dir);
    expect(problems).toEqual([]);
    expect(config.preset).toBe('high');
    expect(config.models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'claude-opus-5', 'grok-4.5']);
    expect(config.consensus.verify_model).toBe('grok-4.5');
    expect(config.consensus.referee_model).toBe('claude-opus-5');
  });

  it('keeps the default preset and reports an unknown one', () => {
    const dir = repoWith({ '.juror.yml': 'preset: enormous\n' });
    const { config, problems } = loadConfig(dir);
    expect(config).toEqual(defaultConfig());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('expected one of starter, fast, balanced, high, ultra');
  });

  it('falls back to the default and reports a problem for an out-of-range number', () => {
    const dir = repoWith({
      '.juror.yml': ['consensus:', '  jaccard_merge_threshold: 7', '  line_window: -3', ''].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(config.consensus.jaccard_merge_threshold).toBe(0.55);
    expect(config.consensus.line_window).toBe(8);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('jaccard_merge_threshold');
  });

  it('reports an unknown key without discarding the rest of the file', () => {
    const dir = repoWith({
      '.juror.yml': ['reveiw:', '  severity_floor: P0', 'review:', '  max_turns: 12', ''].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unknown key `reveiw`');
    expect(config.review.max_turns).toBe(12);
    expect(config.review.severity_floor).toBe('P3');
  });

  it('reports an unknown key inside a section', () => {
    const dir = repoWith({ '.juror.yml': 'review:\n  severity_flooor: P0\n' });
    const { problems } = loadConfig(dir);
    expect(problems).toEqual(['unknown key `review.severity_flooor` — ignored']);
  });

  it('replaces the default models entirely with a user list', () => {
    const dir = repoWith({
      '.juror.yml': ['models:', '  - id: claude-opus-5', '    harness: claude-code', ''].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(problems).toEqual([]);
    expect(config.models).toHaveLength(1);
    expect(config.models[0]?.id).toBe('claude-opus-5');
    expect(config.preset).toBeNull();
    expect(config.consensus.verify_model).toBe('claude-opus-5');
    expect(config.consensus.referee_model).toBe('claude-opus-5');
    // `enabled` and `secret` come from the per-harness default so they can be omitted.
    expect(config.models[0]?.enabled).toBe(true);
    expect(config.models[0]?.secret).toBe('JUROR_ANTHROPIC_API_KEY');
  });

  it('defaults every Kimi Code model to the Fireworks credential', () => {
    const dir = repoWith({
      '.juror.yml': ['models:', '  - id: accounts/fireworks/models/kimi-k3', '    harness: kimi-code', ''].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(problems).toEqual([]);
    expect(config.models[0]?.secret).toBe('JUROR_FIREWORKS_API_KEY');
  });

  it('drops a model with an unknown harness and keeps its siblings', () => {
    const dir = repoWith({
      '.juror.yml': [
        'models:',
        '  - id: unknown-model',
        '    harness: made-up',
        '  - id: grok-4.5',
        '    harness: grok-build',
        '    enabled: false',
        '',
      ].join('\n'),
    });
    const { config, problems } = loadConfig(dir);
    expect(config.models.map((m) => m.id)).toEqual(['grok-4.5']);
    expect(config.models[0]?.enabled).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unknown harness');
  });

  it('keeps the default models when every user entry is unusable', () => {
    const dir = repoWith({ '.juror.yml': 'models:\n  - harness: codex\n' });
    const { config, problems } = loadConfig(dir);
    expect(config.models).toEqual(defaultConfig().models);
    expect(problems.join('\n')).toContain('keeping the current models');
  });

  it('never throws on malformed YAML', () => {
    const dir = repoWith({ '.juror.yml': 'models: [oops\n  - : :\n' });
    const { config, problems } = loadConfig(dir);
    expect(config).toEqual(defaultConfig());
    expect(problems.join('\n')).toContain('not valid YAML');
  });

  it('never throws on a top-level scalar', () => {
    const dir = repoWith({ '.juror.yml': 'just a string\n' });
    const { config, problems } = loadConfig(dir);
    expect(config).toEqual(defaultConfig());
    expect(problems.join('\n')).toContain('mapping');
  });

  it('treats an empty file as the defaults', () => {
    const dir = repoWith({ '.juror.yml': '\n' });
    const { config, problems } = loadConfig(dir);
    expect(config).toEqual(defaultConfig());
    expect(problems).toEqual([]);
  });

  it('honours an override path and reports one that does not exist', () => {
    const dir = repoWith({ 'ci/juror.yml': 'output:\n  cost_receipt: false\n' });
    const ok = loadConfig(dir, join(dir, 'ci/juror.yml'));
    expect(ok.config.output.cost_receipt).toBe(false);

    const missing = loadConfig(dir, join(dir, 'nope.yml'));
    expect(missing.sourcePath).toBeNull();
    expect(missing.config).toEqual(defaultConfig());
    expect(missing.problems.join('\n')).toContain('not found');
  });

  it('accepts null for the referee and verify models', () => {
    const dir = repoWith({ '.juror.yml': 'consensus:\n  verify_model: null\n  referee_model: null\n' });
    const { config, problems } = loadConfig(dir);
    expect(config.consensus.verify_model).toBeNull();
    expect(config.consensus.referee_model).toBeNull();
    expect(problems).toEqual([]);
  });

  it('reports invalid consensus model ids and restores a runnable preset default', () => {
    const dir = repoWith({
      '.juror.yml':
        'preset: high\nconsensus:\n  verify_model: grok-typo\n  referee_model: opus-typo\n',
    });
    const { config, problems } = loadConfig(dir);

    expect(config.consensus.verify_model).toBe('grok-4.5');
    expect(config.consensus.referee_model).toBe('grok-4.5');
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('is not a configured model id');
  });

  it('parses the example .juror.yml shipped at the repo root without problems', () => {
    const { config, problems, sourcePath } = loadConfig(fileURLToPath(new URL('..', import.meta.url)));
    expect(sourcePath).not.toBeNull();
    expect(problems).toEqual([]);
    expect(config).toEqual(defaultConfig());
  });
});

describe('resolveModelRuntime', () => {
  it('falls back id → harness_model → pricing_key in the documented order', () => {
    expect(resolveModelRuntime({ id: 'grok-4.5', harness: 'grok-build', enabled: true, secret: 'XAI_API_KEY' })).toEqual({
      harnessModel: 'grok-4.5',
      pricingKey: 'grok-4.5',
      label: 'Grok 4.5',
    });

    expect(
      resolveModelRuntime({
        id: 'deepseek-v4-flash-0731',
        harness: 'opencode',
        enabled: true,
        secret: 'FIREWORKS_API_KEY',
        harness_model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
      }),
    ).toEqual({
      harnessModel: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
      pricingKey: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
      label: 'Deepseek V4 Flash 0731',
    });
  });

  it('prefers an explicit pricing_key and label', () => {
    expect(
      resolveModelRuntime({
        id: 'deepseek-v4-flash-0731',
        harness: 'opencode',
        enabled: true,
        secret: 'FIREWORKS_API_KEY',
        harness_model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
        pricing_key: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        label: 'DeepSeek V4 Flash',
      }),
    ).toEqual({
      harnessModel: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
      pricingKey: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      label: 'DeepSeek V4 Flash',
    });
  });
});

describe('prompts', () => {
  it('loads each template and leaves its placeholders intact', () => {
    for (const name of ['review', 'referee', 'verify'] as const) {
      const tpl = loadPromptTemplate(name);
      expect(tpl.length).toBeGreaterThan(200);
      expect(tpl).toMatch(/\{\{[A-Z_]+\}\}/);
    }
    expect(loadPromptTemplate('review')).toContain('{{FINDINGS_PATH}}');
    expect(loadPromptTemplate('review')).toContain('{{DIFF}}');
    expect(loadPromptTemplate('review')).toContain('{{REPO_INSTRUCTIONS}}');
    expect(loadPromptTemplate('verify')).toContain('{{CODE_EXCERPT}}');
    expect(loadPromptTemplate('verify')).toContain('{{REPO_INSTRUCTIONS}}');
  });

  it('substitutes every occurrence and keeps unknown placeholders verbatim', () => {
    const out = renderTemplate('a {{X}} b {{X}} c {{Y}}', { X: 'one' });
    expect(out).toBe('a one b one c {{Y}}');
  });

  it('does not interpret $ sequences in the substituted value', () => {
    expect(renderTemplate('{{DIFF}}', { DIFF: '-$& +$1 $$' })).toBe('-$& +$1 $$');
  });
});
