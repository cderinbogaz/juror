import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyReviewPreset, defaultConfig, loadConfig } from '../src/config.js';
import {
  credentialReadiness,
  installQaConfig,
  installManagedWorkflow,
  managedWorkflowIsPristine,
  renderManagedQaWorkflow,
  renderManagedWorkflow,
  renderQaConfigBlock,
  runInitCommand,
  uploadProviderSecrets,
  uploadQaSecretsBundle,
} from '../src/init.js';
import type { RunOptions } from '../src/util/proc.js';

const dirs: string[] = [];
const packageVersion = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version;

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'juror-init-'));
  dirs.push(dir);
  return dir;
}

function cliTestEnv(repo: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NO_COLOR: '1',
    GH_CONFIG_DIR: join(repo, '.gh-test-config'),
    GH_PROMPT_DISABLED: '1',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('credentialReadiness', () => {
  it('reports sources and runnable jury size without retaining secret values', () => {
    const readiness = credentialReadiness(
      {
        JUROR_OPENAI_API_KEY: 'dedicated-openai-secret',
        OPENAI_API_KEY: 'legacy-openai-secret',
        FIREWORKS_API_KEY: 'legacy-fireworks-secret',
      },
      defaultConfig(),
    );

    expect(readiness.providers).toEqual([
      {
        canonicalName: 'JUROR_ANTHROPIC_API_KEY',
        label: 'Anthropic',
        available: false,
        source: 'JUROR_ANTHROPIC_API_KEY',
      },
      {
        canonicalName: 'JUROR_OPENAI_API_KEY',
        label: 'OpenAI',
        available: true,
        source: 'JUROR_OPENAI_API_KEY',
      },
      {
        canonicalName: 'JUROR_XAI_API_KEY',
        label: 'xAI',
        available: false,
        source: 'JUROR_XAI_API_KEY',
      },
      {
        canonicalName: 'JUROR_FIREWORKS_API_KEY',
        label: 'Fireworks',
        available: true,
        source: 'FIREWORKS_API_KEY',
      },
      {
        canonicalName: 'JUROR_OPENROUTER_API_KEY',
        label: 'OpenRouter',
        available: false,
        source: 'JUROR_OPENROUTER_API_KEY',
      },
      {
        canonicalName: 'JUROR_SCALEWAY_API_KEY',
        label: 'Scaleway',
        available: false,
        source: 'JUROR_SCALEWAY_API_KEY',
      },
    ]);
    expect(readiness.runnableModels).toEqual(['gpt-5.6-luna', 'deepseek-v4-flash-0731']);
    expect(readiness.juryKind).toBe('multi-model');
    expect(JSON.stringify(readiness)).not.toContain('dedicated-openai-secret');
    expect(JSON.stringify(readiness)).not.toContain('legacy-fireworks-secret');
  });

  it('makes single-model degradation explicit', () => {
    const readiness = credentialReadiness(
      { JUROR_OPENAI_API_KEY: 'one-secret' },
      defaultConfig(),
    );

    expect(readiness.runnableModels).toEqual(['gpt-5.6-luna']);
    expect(readiness.juryKind).toBe('single-model');
  });

  it('recognizes two independent starter families from one OpenRouter credential', () => {
    const readiness = credentialReadiness(
      { JUROR_OPENROUTER_API_KEY: 'one-aggregator-secret' },
      applyReviewPreset(defaultConfig(), 'starter'),
    );

    expect(readiness.runnableModels).toEqual([
      'openrouter-gpt-5.6-luna',
      'openrouter-deepseek-v4-flash',
    ]);
    expect(readiness.runnableFamilies).toEqual(['openai', 'deepseek']);
    expect(readiness.juryKind).toBe('multi-model');
    expect(JSON.stringify(readiness)).not.toContain('one-aggregator-secret');
  });
});

describe('managed workflow', () => {
  const sha = 'a'.repeat(40);

  it('pins Juror immutably and carries a readable release comment', () => {
    const workflow = renderManagedWorkflow({ actionSha: sha, version: '1.3.3' });

    expect(workflow).toContain(`uses: juror-ai/juror@${sha} # v1.3.3`);
    expect(workflow).toContain(
      'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    );
    expect(workflow).not.toContain('juror-ai/juror@v1');
    expect(workflow).not.toContain('actions/checkout@v4');
    // Base-revision policy needs the whole ref graph; only history blobs may be deferred.
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('filter: blob:none');
    expect(workflow).toContain('JUROR_OPENROUTER_API_KEY: ${{ secrets.JUROR_OPENROUTER_API_KEY }}');
    expect(workflow).toContain('JUROR_SCALEWAY_API_KEY: ${{ secrets.JUROR_SCALEWAY_API_KEY }}');
    expect(workflow).toContain('# juror:init:managed sha256:');
    expect(managedWorkflowIsPristine(workflow)).toBe(true);
  });

  it('creates once, stays idempotent, and refuses to overwrite user edits', async () => {
    const repo = tempRepo();
    const workflow = renderManagedWorkflow({ actionSha: sha, version: '1.3.3' });

    await expect(installManagedWorkflow(repo, workflow, false)).resolves.toEqual({
      path: join(repo, '.github/workflows/juror.yml'),
      outcome: 'created',
    });
    await expect(installManagedWorkflow(repo, workflow, false)).resolves.toEqual({
      path: join(repo, '.github/workflows/juror.yml'),
      outcome: 'unchanged',
    });

    const path = join(repo, '.github/workflows/juror.yml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}# deliberate edit\n`, 'utf8');
    expect(managedWorkflowIsPristine(readFileSync(path, 'utf8'))).toBe(false);

    await expect(installManagedWorkflow(repo, workflow, false)).resolves.toEqual({
      path,
      outcome: 'preserved',
    });
    expect(readFileSync(path, 'utf8')).toContain('# deliberate edit');
  });

  it('plans without touching the filesystem in dry-run mode', async () => {
    const repo = tempRepo();
    const workflow = renderManagedWorkflow({ actionSha: sha, version: '1.3.3' });

    await expect(installManagedWorkflow(repo, workflow, true)).resolves.toMatchObject({
      outcome: 'planned-create',
    });
    expect(() => readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8')).toThrow();
  });
});

describe('managed post-merge QA setup', () => {
  const sha = 'c'.repeat(40);

  it('renders a separate immutable workflow scoped to merged same-repository PRs', () => {
    const workflow = renderManagedQaWorkflow({ actionSha: sha, version: '1.4.1' });

    expect(workflow).toContain('name: Juror QA');
    expect(workflow).toContain('types: [closed]');
    expect(workflow).toContain('timeout-minutes: 95');
    expect(workflow).toContain(
      'if: github.event.pull_request.merged == true && github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(workflow).toContain(`uses: juror-ai/juror/qa@${sha} # v1.4.1`);
    expect(workflow).not.toContain('juror-ai/juror/qa@v1');
    expect(workflow).toContain(
      'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    );
    expect(workflow).toContain('deployments: read');
    expect(workflow).toContain('attestations: read');
    expect(workflow).toContain('packages: read');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain(
      'group: juror-qa-${{ github.repository }}-${{ github.event.pull_request.number }}',
    );
    expect(workflow).not.toContain('queue:');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('filter: blob:none');
    expect(workflow).toContain('pr-number: ${{ github.event.pull_request.number }}');
    expect(workflow).toContain('JUROR_QA_SECRETS_B64: ${{ secrets.JUROR_QA_SECRETS_B64 }}');
    expect(managedWorkflowIsPristine(workflow)).toBe(true);
  });

  it('renders a safely disabled QA block with conservative bounded defaults', () => {
    const block = renderQaConfigBlock();

    expect(block).toContain('qa:\n  enabled: false');
    expect(block).toContain('testability:\n    early_exit_paths: []');
    expect(block).toContain('strategy: staging-first');
    expect(block).toContain('session_bootstrap: null');
    expect(block).toContain('browser_secret_headers: []');
    expect(block).toContain('allowed_origins: []');
    expect(block).toContain('reset: null');
    expect(block).toContain('interaction_policy: disabled');
    expect(block).toContain('max_scenarios: 6');
    expect(block).toContain('max_browser_operations: 40');
    expect(block).toContain('timeout_seconds: 1200');
    expect(block).toContain('video: all');
    expect(block).toContain('retention_days: 14');

    const parsed = loadConfig(tempRepo());
    expect(parsed.config.qa.enabled).toBe(false);
  });

  it('enables a configured target and derives its exact browser origin', () => {
    const block = renderQaConfigBlock({
      targetUrl: 'https://staging.example.test/app',
      allowOrigins: ['https://api.example.test', 'https://staging.example.test'],
    });
    const repo = tempRepo();
    writeFileSync(join(repo, '.juror.yml'), `version: 1\n\n${block}`, 'utf8');

    const loaded = loadConfig(repo);
    expect(loaded.problems).toEqual([]);
    expect(loaded.config.qa.enabled).toBe(true);
    expect(loaded.config.qa.target.static_url).toBe('https://staging.example.test/app');
    expect(loaded.config.qa.sandbox.allowed_origins).toEqual([
      'https://api.example.test',
      'https://staging.example.test',
    ]);
  });

  it('renders Node-bracketed IPv6 loopback HTTP targets and origins', () => {
    const block = renderQaConfigBlock({
      targetUrl: 'http://[::1]:4173/app',
      allowOrigins: ['http://[::1]:4173'],
    });
    const repo = tempRepo();
    writeFileSync(join(repo, '.juror.yml'), `version: 1\n\n${block}`, 'utf8');

    const loaded = loadConfig(repo);
    expect(loaded.problems).toEqual([]);
    expect(loaded.config.qa.target.static_url).toBe('http://[::1]:4173/app');
    expect(loaded.config.qa.sandbox.allowed_origins).toEqual(['http://[::1]:4173']);
  });

  it('rejects unsafe targets and non-origin allowlist entries before rendering', () => {
    expect(() => renderQaConfigBlock({ targetUrl: 'http://staging.example.test' })).toThrow(
      '--target-url must be an absolute HTTPS URL',
    );
    expect(() => renderQaConfigBlock({ targetUrl: 'https://user:pass@example.test' })).toThrow(
      '--target-url must be an absolute HTTPS URL',
    );
    expect(() => renderQaConfigBlock({ targetUrl: 'https://example.test/?token=secret' })).toThrow(
      '--target-url must be an absolute HTTPS URL',
    );
    expect(() => renderQaConfigBlock({ targetUrl: 'https://example.test/#session' })).toThrow(
      '--target-url must be an absolute HTTPS URL',
    );
    expect(() => renderQaConfigBlock({ allowOrigins: ['https://example.test/path'] })).toThrow(
      '--allow-origin must be an exact HTTPS origin',
    );
    expect(() => renderQaConfigBlock({ targetUrl: 'https://203.0.113.10/app' })).toThrow(
      '--target-url must be an absolute HTTPS URL',
    );
    expect(() => renderQaConfigBlock({ allowOrigins: ['https://[2001:db8::1]'] })).toThrow(
      '--allow-origin must be an absolute HTTPS URL',
    );
  });

  it('creates a parseable config, appends without destroying user policy, and stays idempotent', async () => {
    const fresh = tempRepo();
    await expect(installQaConfig(fresh, null, false)).resolves.toEqual({
      path: join(fresh, '.juror.yml'),
      outcome: 'created',
    });
    expect(loadConfig(fresh).config.qa.enabled).toBe(false);
    await expect(installQaConfig(fresh, join(fresh, '.juror.yml'), false)).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    expect(readFileSync(join(fresh, '.juror.yml'), 'utf8').match(/^qa\s*:/gm)).toHaveLength(1);

    const existing = tempRepo();
    const existingPath = join(existing, '.juror.yml');
    writeFileSync(existingPath, 'version: 1\nreview:\n  severity_floor: P1\n', 'utf8');
    await expect(installQaConfig(existing, existingPath, false)).resolves.toEqual({
      path: existingPath,
      outcome: 'updated',
    });
    const text = readFileSync(existingPath, 'utf8');
    expect(text).toContain('severity_floor: P1');
    expect(text.match(/^qa\s*:/gm)).toHaveLength(1);
    const loaded = loadConfig(existing);
    expect(loaded.config.review.severity_floor).toBe('P1');
    expect(loaded.config.qa.enabled).toBe(false);
    expect(loaded.problems).toEqual([]);
  });

  it('plans QA config creation without writing during a dry run', async () => {
    const repo = tempRepo();

    await expect(installQaConfig(repo, null, true)).resolves.toEqual({
      path: join(repo, '.juror.yml'),
      outcome: 'planned-create',
    });
    expect(() => readFileSync(join(repo, '.juror.yml'), 'utf8')).toThrow();
  });
});

describe('uploadProviderSecrets', () => {
  it('passes values only over stdin and uploads to the dedicated canonical names', async () => {
    const calls: { argv: string[]; opts: RunOptions }[] = [];
    const runner = vi.fn(async (argv: string[], opts: RunOptions = {}) => {
      calls.push({ argv, opts });
      return { stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false };
    });

    const uploaded = await uploadProviderSecrets(
      {
        OPENAI_API_KEY: 'legacy-value',
        JUROR_FIREWORKS_API_KEY: 'dedicated-value',
      },
      ['JUROR_OPENAI_API_KEY', 'JUROR_FIREWORKS_API_KEY'],
      'owner/repo',
      runner,
    );

    expect(uploaded).toEqual(['JUROR_OPENAI_API_KEY', 'JUROR_FIREWORKS_API_KEY']);
    expect(calls).toEqual([
      {
        argv: ['gh', 'secret', 'set', 'JUROR_OPENAI_API_KEY', '--repo', 'owner/repo'],
        opts: { stdin: 'legacy-value', timeoutMs: 120_000 },
      },
      {
        argv: ['gh', 'secret', 'set', 'JUROR_FIREWORKS_API_KEY', '--repo', 'owner/repo'],
        opts: { stdin: 'dedicated-value', timeoutMs: 120_000 },
      },
    ]);
    expect(calls.flatMap((call) => call.argv).join(' ')).not.toContain('legacy-value');
    expect(calls.flatMap((call) => call.argv).join(' ')).not.toContain('dedicated-value');
  });

  it('fails without echoing a rejected secret', async () => {
    const runner = vi.fn(async () => ({
      stdout: '',
      stderr: 'permission denied',
      exitCode: 1,
      signal: null,
      durationMs: 1,
      timedOut: false,
    }));

    await expect(
      uploadProviderSecrets(
        { JUROR_OPENAI_API_KEY: 'never-print-this' },
        ['JUROR_OPENAI_API_KEY'],
        'owner/repo',
        runner,
      ),
    ).rejects.toThrow('JUROR_OPENAI_API_KEY');
    await expect(
      uploadProviderSecrets(
        { JUROR_OPENAI_API_KEY: 'never-print-this' },
        ['JUROR_OPENAI_API_KEY'],
        'owner/repo',
        runner,
      ),
    ).rejects.not.toThrow('never-print-this');
  });

  it('rejects names outside the fixed provider allowlist', async () => {
    await expect(
      uploadProviderSecrets(
        { GITHUB_TOKEN: 'control-plane-token' },
        ['GITHUB_TOKEN'],
        'owner/repo',
        vi.fn(),
      ),
    ).rejects.toThrow('Unsupported Juror provider secret');
  });

  it('uploads an OpenRouter key through stdin under the dedicated name', async () => {
    const calls: { argv: string[]; opts: RunOptions }[] = [];
    const runner = vi.fn(async (argv: string[], opts: RunOptions = {}) => {
      calls.push({ argv, opts });
      return { stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false };
    });

    await expect(
      uploadProviderSecrets(
        { OPENROUTER_API_KEY: 'aggregator-value' },
        ['JUROR_OPENROUTER_API_KEY'],
        'owner/repo',
        runner,
      ),
    ).resolves.toEqual(['JUROR_OPENROUTER_API_KEY']);
    expect(calls).toEqual([{
      argv: ['gh', 'secret', 'set', 'JUROR_OPENROUTER_API_KEY', '--repo', 'owner/repo'],
      opts: { stdin: 'aggregator-value', timeoutMs: 120_000 },
    }]);
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain('aggregator-value');
  });
});

describe('uploadQaSecretsBundle', () => {
  it('uploads the exact opaque value over stdin without trying to decode or print it', async () => {
    const calls: { argv: string[]; opts: RunOptions }[] = [];
    const runner = vi.fn(async (argv: string[], opts: RunOptions = {}) => {
      calls.push({ argv, opts });
      return { stdout: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false };
    });
    const opaqueValue = 'intentionally-not-validated-as-base64-during-init';

    await expect(
      uploadQaSecretsBundle(
        { JUROR_QA_SECRETS_B64: opaqueValue },
        'owner/repo',
        runner,
      ),
    ).resolves.toEqual(['JUROR_QA_SECRETS_B64']);

    expect(calls).toEqual([{
      argv: ['gh', 'secret', 'set', 'JUROR_QA_SECRETS_B64', '--repo', 'owner/repo'],
      opts: { stdin: opaqueValue, timeoutMs: 120_000 },
    }]);
    expect(calls[0]?.argv.join(' ')).not.toContain(opaqueValue);
  });

  it('does nothing when the dedicated bundle is absent and never falls back to a bare name', async () => {
    const runner = vi.fn();

    await expect(
      uploadQaSecretsBundle({ QA_SECRETS_B64: 'wrong-name' }, 'owner/repo', runner),
    ).resolves.toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not include a rejected bundle even when the GitHub CLI echoes stdin', async () => {
    const opaqueValue = 'bundle-that-must-stay-redacted';
    const runner = vi.fn(async () => ({
      stdout: opaqueValue,
      stderr: opaqueValue,
      exitCode: 1,
      signal: null,
      durationMs: 1,
      timedOut: false,
    }));

    const upload = uploadQaSecretsBundle(
      { JUROR_QA_SECRETS_B64: opaqueValue },
      'owner/repo',
      runner,
    );
    await expect(upload).rejects.toThrow('JUROR_QA_SECRETS_B64');
    await expect(upload).rejects.not.toThrow(opaqueValue);
  });
});

describe('runInitCommand QA secret setup', () => {
  it('requires an OpenAI credential before QA secret setup can write files', async () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const runner = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'git' && argv[1] === 'rev-parse') return commandResult('true\n');
      if (argv[0] === '/usr/bin/env' && argv[1] === 'which') return commandResult('/usr/bin/gh\n');
      if (argv[0] === 'gh' && argv[1] === 'auth') return commandResult('');
      if (argv[0] === 'gh' && argv[1] === 'api') return commandResult('qa-maintainer\n');
      if (argv[0] === 'gh' && argv[1] === 'repo') return commandResult('main\n');
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    });

    await expect(
      runInitCommand({
        repoDir: repo,
        repo: 'owner/repo',
        env: {
          JUROR_ANTHROPIC_API_KEY: 'not-the-qa-provider',
          JUROR_QA_SECRETS_B64: 'opaque-browser-bundle',
        },
        version: '1.4.1',
        actionSha: 'e'.repeat(40),
        qa: true,
        setSecrets: true,
        yes: true,
        runner,
        write: () => {},
      }),
    ).rejects.toThrow('--qa --set-secrets requires JUROR_OPENAI_API_KEY');
    expect(() => readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8')).toThrow();
    expect(() => readFileSync(join(repo, '.github/workflows/juror-qa.yml'), 'utf8')).toThrow();
    expect(() => readFileSync(join(repo, '.juror.yml'), 'utf8')).toThrow();
  });

  it('uploads providers and the opaque QA bundle only after confirmation', async () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const secretCalls: { argv: string[]; stdin: string | undefined }[] = [];
    let confirmed = false;
    const runner = vi.fn(async (argv: string[], opts: RunOptions = {}) => {
      if (argv[0] === 'git' && argv[1] === 'rev-parse') return commandResult('true\n');
      if (argv[0] === '/usr/bin/env' && argv[1] === 'which') return commandResult('/usr/bin/gh\n');
      if (argv[0] === 'gh' && argv[1] === 'auth') return commandResult('');
      if (argv[0] === 'gh' && argv[1] === 'api') return commandResult('qa-maintainer\n');
      if (argv[0] === 'gh' && argv[1] === 'repo') return commandResult('main\n');
      if (argv[0] === 'gh' && argv[1] === 'secret') {
        expect(confirmed).toBe(true);
        secretCalls.push({ argv, stdin: opts.stdin });
        return commandResult('');
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    });
    const confirm = vi.fn(async () => {
      confirmed = true;
      return true;
    });
    const output: string[] = [];
    const providerSecret = 'provider-value-never-print';
    const qaBundle = 'opaque-bundle-never-print';

    const result = await runInitCommand({
      repoDir: repo,
      repo: 'owner/repo',
      env: {
        JUROR_OPENAI_API_KEY: providerSecret,
        JUROR_QA_SECRETS_B64: qaBundle,
      },
      version: '1.4.1',
      actionSha: 'e'.repeat(40),
      qa: true,
      setSecrets: true,
      runner,
      confirm,
      write: (text) => output.push(text),
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('including the opaque JUROR_QA_SECRETS_B64');
    expect(result.uploadedSecrets).toEqual(['JUROR_OPENAI_API_KEY', 'JUROR_QA_SECRETS_B64']);
    expect(secretCalls).toEqual([
      {
        argv: ['gh', 'secret', 'set', 'JUROR_OPENAI_API_KEY', '--repo', 'owner/repo'],
        stdin: providerSecret,
      },
      {
        argv: ['gh', 'secret', 'set', 'JUROR_QA_SECRETS_B64', '--repo', 'owner/repo'],
        stdin: qaBundle,
      },
    ]);
    const rendered = output.join('');
    expect(rendered).toContain('QA browser auth: available via JUROR_QA_SECRETS_B64 (opaque; not inspected)');
    expect(rendered).not.toContain(providerSecret);
    expect(rendered).not.toContain(qaBundle);
  });

  it('does not consider or upload the QA bundle without the explicit --qa opt-in', async () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const runner = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'git' && argv[1] === 'rev-parse') return commandResult('true\n');
      if (argv[0] === '/usr/bin/env' && argv[1] === 'which') return commandResult('/usr/bin/gh\n');
      if (argv[0] === 'gh' && argv[1] === 'auth') return commandResult('');
      if (argv[0] === 'gh' && argv[1] === 'api') return commandResult('qa-maintainer\n');
      if (argv[0] === 'gh' && argv[1] === 'repo') return commandResult('main\n');
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    });

    await expect(
      runInitCommand({
        repoDir: repo,
        repo: 'owner/repo',
        env: { JUROR_QA_SECRETS_B64: 'qa-only-value' },
        version: '1.4.1',
        actionSha: 'e'.repeat(40),
        setSecrets: true,
        yes: true,
        runner,
        write: () => {},
      }),
    ).rejects.toThrow('--set-secrets found no provider keys');
    expect(runner).not.toHaveBeenCalledWith(
      expect.arrayContaining(['secret', 'set', 'JUROR_QA_SECRETS_B64']),
      expect.anything(),
    );
  });
});

describe('juror init CLI', () => {
  it('creates the managed workflow and explains single-model readiness', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });
    writeFileSync(join(repo, '.env'), 'JUROR_OPENAI_API_KEY=test-only-value\n', 'utf8');

    const output = execFileSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--action-sha',
        'b'.repeat(40),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cliTestEnv(repo),
      },
    );

    expect(output).toContain('Repository: owner/example');
    expect(output).toContain('single-model');
    expect(output).toContain('Workflow: .github/workflows/juror.yml created');
    expect(output).not.toContain('test-only-value');
    const workflow = readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8');
    expect(workflow).toContain(`juror-ai/juror@${'b'.repeat(40)} # v${packageVersion}`);
  });

  it('does not create a workflow when requested secret setup cannot start', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });

    const result = spawnSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--action-sha',
        'b'.repeat(40),
        '--set-secrets',
        '--yes',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cliTestEnv(repo),
      },
    );

    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8')).toThrow();
  });

  it('persists an explicit starter preset and reports a one-key multi-model jury', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });
    writeFileSync(join(repo, '.env'), 'JUROR_OPENROUTER_API_KEY=test-only-value\n', 'utf8');

    const output = execFileSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--preset',
        'starter',
        '--action-sha',
        'b'.repeat(40),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cliTestEnv(repo),
      },
    );

    expect(output).toContain('Preset: starter (CLI override)');
    expect(output).toContain('2 runnable models across 2 families');
    expect(output).not.toContain('test-only-value');
    const workflow = readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8');
    expect(workflow).toContain('preset: starter');
  });

  it('installs the separate post-merge workflow and QA config only with --qa', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });
    writeFileSync(join(repo, '.juror.yml'), 'version: 1\nreview:\n  severity_floor: P2\n', 'utf8');

    const output = execFileSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--qa',
        '--action-sha',
        'd'.repeat(40),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cliTestEnv(repo),
      },
    );

    expect(output).toContain('QA Workflow: .github/workflows/juror-qa.yml created');
    expect(output).toContain('QA config: .juror.yml (updated)');
    expect(output).toContain('Next: review and commit .github/workflows/juror.yml');
    expect(output).toContain(
      'QA setup: review and commit .github/workflows/juror-qa.yml and .juror.yml',
    );
    expect(output).toContain(
      'Post-merge QA is opt-in through .juror.yml and, when enabled, runs from .github/workflows/juror-qa.yml',
    );
    expect(output).toContain('missing optional JUROR_QA_SECRETS_B64');
    expect(output).toContain('QA remains disabled because no target URL or allowed origin is configured');

    const reviewWorkflow = readFileSync(join(repo, '.github/workflows/juror.yml'), 'utf8');
    const qaWorkflow = readFileSync(join(repo, '.github/workflows/juror-qa.yml'), 'utf8');
    expect(reviewWorkflow).toContain(`juror-ai/juror@${'d'.repeat(40)}`);
    expect(reviewWorkflow).not.toContain('juror-ai/juror/qa@');
    expect(qaWorkflow).toContain(`juror-ai/juror/qa@${'d'.repeat(40)}`);
    expect(qaWorkflow).toContain('types: [closed]');

    const loaded = loadConfig(repo);
    expect(loaded.config.review.severity_floor).toBe('P2');
    expect(loaded.config.qa.enabled).toBe(false);
    expect(loaded.problems).toEqual([]);
  });

  it('generates an enabled target policy from init target and origin flags', () => {
    const repo = tempRepo();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/example.git'], { cwd: repo });

    const output = execFileSync(
      join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
      [
        join(process.cwd(), 'src/cli.ts'),
        'init',
        '--repo-dir',
        repo,
        '--qa',
        '--target-url',
        'https://staging.example.test/app',
        '--allow-origin',
        'https://api.example.test',
        '--action-sha',
        'd'.repeat(40),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cliTestEnv(repo),
      },
    );

    expect(output).toContain('QA target policy enabled for 2 exact browser origin(s)');
    const loaded = loadConfig(repo);
    expect(loaded.problems).toEqual([]);
    expect(loaded.config.qa.enabled).toBe(true);
    expect(loaded.config.qa.target.static_url).toBe('https://staging.example.test/app');
    expect(loaded.config.qa.sandbox.allowed_origins).toEqual([
      'https://staging.example.test',
      'https://api.example.test',
    ]);
  });
});

function commandResult(stdout: string) {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
  } as const;
}
