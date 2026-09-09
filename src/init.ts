/** Secure, non-destructive onboarding for `juror init`. */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { applyReviewPreset, loadConfig, readSecret } from './config.js';
import type { HarnessId, JurorConfig, ModelConfig, ReviewPreset } from './types.js';
import { run, type RunOptions } from './util/proc.js';
import { isIpLiteralHostname, isLoopbackHostname } from './util/url.js';
import { repoRoot } from './util/workspace.js';

const MANAGED_PREFIX = '# juror:init:managed sha256:';
const ACTION_REPOSITORY = 'Juror-AI/juror';
const QA_SECRETS_BUNDLE = 'JUROR_QA_SECRETS_B64';

export interface ProviderReadiness {
  canonicalName: string;
  label: string;
  available: boolean;
  source: string;
}

export interface CredentialReadiness {
  providers: ProviderReadiness[];
  runnableModels: string[];
  runnableFamilies: string[];
  juryKind: 'none' | 'single-model' | 'multi-model';
}

export interface WorkflowInstallResult {
  path: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'preserved' | 'planned-create' | 'planned-update';
}

interface HarnessIO {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<HarnessIO>;

const PROVIDERS = [
  { canonicalName: 'JUROR_ANTHROPIC_API_KEY', label: 'Anthropic' },
  { canonicalName: 'JUROR_OPENAI_API_KEY', label: 'OpenAI' },
  { canonicalName: 'JUROR_XAI_API_KEY', label: 'xAI' },
  { canonicalName: 'JUROR_FIREWORKS_API_KEY', label: 'Fireworks' },
  { canonicalName: 'JUROR_OPENROUTER_API_KEY', label: 'OpenRouter' },
  { canonicalName: 'JUROR_SCALEWAY_API_KEY', label: 'Scaleway' },
] as const;

export interface InitCommandOptions {
  repoDir: string;
  repo?: string | null;
  env: Record<string, string | undefined>;
  version: string;
  actionSha?: string | null;
  preset?: ReviewPreset | null;
  dryRun?: boolean;
  setSecrets?: boolean;
  yes?: boolean;
  /** Install the opt-in post-merge browser QA workflow and config block. */
  qa?: boolean;
  /** Static staging/preview URL used by the generated QA policy. */
  targetUrl?: string | null;
  /** Exact browser origins added to the generated QA policy. */
  allowOrigins?: readonly string[];
  runner?: CommandRunner;
  write?: (text: string) => void;
  confirm?: (question: string) => Promise<boolean>;
}

export interface InitCommandResult {
  repoDir: string;
  repo: string | null;
  defaultBranch: string;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  configPath: string | null;
  actionSha: string;
  readiness: CredentialReadiness;
  workflow: WorkflowInstallResult;
  qaWorkflow: WorkflowInstallResult | null;
  qaConfig: WorkflowInstallResult | null;
  uploadedSecrets: string[];
}

export function credentialReadiness(
  env: Record<string, string | undefined>,
  config: JurorConfig,
): CredentialReadiness {
  const providers = PROVIDERS.map(({ canonicalName, label }) => {
    const secret = readSecret(env, canonicalName);
    return {
      canonicalName,
      label,
      available: Boolean(secret.value),
      source: secret.source,
    };
  });

  const runnable = config.models.filter(
    (model) => model.enabled && Boolean(readSecret(env, model.secret).value),
  );
  const runnableModels = runnable.map((model) => model.id);
  const runnableFamilies = [...new Set(runnable.map(modelFamily))];
  const juryKind =
    runnableFamilies.length >= 2
      ? 'multi-model'
      : runnableModels.length >= 1
        ? 'single-model'
        : 'none';

  return { providers, runnableModels, runnableFamilies, juryKind };
}

function modelFamily(model: ModelConfig): string {
  const fixed: Partial<Record<HarnessId, string>> = {
    'claude-code': 'anthropic',
    codex: 'openai',
    'grok-build': 'xai',
    'kimi-code': 'moonshot',
  };
  if (fixed[model.harness]) return fixed[model.harness] as string;

  const identity = `${model.id} ${model.harness_model ?? ''}`.toLowerCase();
  if (identity.includes('deepseek')) return 'deepseek';
  if (identity.includes('kimi') || identity.includes('moonshot')) return 'moonshot';
  if (identity.includes('claude') || identity.includes('anthropic')) return 'anthropic';
  if (identity.includes('gpt') || identity.includes('openai')) return 'openai';
  if (identity.includes('grok') || identity.includes('xai')) return 'xai';
  return model.id.toLowerCase();
}

export function renderManagedWorkflow(options: {
  actionSha: string;
  version: string;
  preset?: ReviewPreset | null;
}): string {
  assertActionSha(options.actionSha);
  const body = `# Juror v${options.version}\n` +
    `# Edit .juror.yml for review policy. Run \`juror init\` to refresh this managed workflow.\n` +
    `name: Juror\n\n` +
    `on:\n` +
    `  pull_request:\n` +
    `    types: [opened, synchronize, reopened]\n\n` +
    `permissions:\n` +
    `  contents: read\n` +
    `  pull-requests: write\n\n` +
    `concurrency:\n` +
    `  group: juror-\${{ github.event.pull_request.number }}\n` +
    `  cancel-in-progress: true\n\n` +
    `jobs:\n` +
    `  review:\n` +
    `    if: github.event.pull_request.head.repo.full_name == github.repository\n` +
    `    runs-on: ubuntu-latest\n` +
    `    steps:\n` +
    `      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n` +
    `        with:\n` +
    `          # Full ref graph for base-revision policy; blobless so history file contents\n` +
    `          # are fetched on demand instead of up front.\n` +
    `          fetch-depth: 0\n` +
    `          filter: blob:none\n` +
    `      - uses: juror-ai/juror@${options.actionSha} # v${options.version}\n` +
    `        with:\n` +
    `          github-token: \${{ secrets.GITHUB_TOKEN }}\n` +
    (options.preset ? `          preset: ${options.preset}\n` : '') +
    `        env:\n` +
    `          JUROR_OPENAI_API_KEY: \${{ secrets.JUROR_OPENAI_API_KEY }}\n` +
    `          JUROR_ANTHROPIC_API_KEY: \${{ secrets.JUROR_ANTHROPIC_API_KEY }}\n` +
    `          JUROR_XAI_API_KEY: \${{ secrets.JUROR_XAI_API_KEY }}\n` +
    `          JUROR_FIREWORKS_API_KEY: \${{ secrets.JUROR_FIREWORKS_API_KEY }}\n` +
    `          JUROR_OPENROUTER_API_KEY: \${{ secrets.JUROR_OPENROUTER_API_KEY }}\n` +
    `          JUROR_SCALEWAY_API_KEY: \${{ secrets.JUROR_SCALEWAY_API_KEY }}\n`;
  const digest = createHash('sha256').update(body).digest('hex');
  return `${MANAGED_PREFIX}${digest}\n${body}`;
}

export function renderManagedQaWorkflow(options: { actionSha: string; version: string }): string {
  assertActionSha(options.actionSha);
  const body = `# Juror QA v${options.version}\n` +
    `# Edit .juror.yml for QA policy. Run \`juror init --qa\` to refresh this managed workflow.\n` +
    `name: Juror QA\n\n` +
    `on:\n` +
    `  pull_request:\n` +
    `    types: [closed]\n\n` +
    `permissions:\n` +
    `  actions: read\n` +
    `  attestations: read\n` +
    `  contents: read\n` +
    `  deployments: read\n` +
    `  packages: read\n` +
    `  pull-requests: write\n\n` +
    `concurrency:\n` +
    // GitHub concurrency groups retain at most one pending run. Group by PR so a
    // burst of merges cannot silently replace an older PR's pending QA run.
    `  group: juror-qa-\${{ github.repository }}-\${{ github.event.pull_request.number }}\n` +
    `  cancel-in-progress: false\n\n` +
    `jobs:\n` +
    `  qa:\n` +
    `    if: github.event.pull_request.merged == true && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.base.ref == github.event.repository.default_branch\n` +
    `    runs-on: ubuntu-latest\n` +
    // Trusted policy permits up to 60 minutes of deployment readiness plus a
    // 20-minute QA run. Keep enough job headroom for checkout, image startup,
    // the final reset/recheck, evidence finalization, and comment publication.
    `    timeout-minutes: 95\n` +
    `    steps:\n` +
    `      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n` +
    `        with:\n` +
    `          fetch-depth: 0\n` +
    `          persist-credentials: false\n` +
    `      - uses: juror-ai/juror/qa@${options.actionSha} # v${options.version}\n` +
    `        with:\n` +
    `          github-token: \${{ secrets.GITHUB_TOKEN }}\n` +
    `          pr-number: \${{ github.event.pull_request.number }}\n` +
    `        env:\n` +
    `          JUROR_OPENAI_API_KEY: \${{ secrets.JUROR_OPENAI_API_KEY }}\n` +
    `          JUROR_QA_SECRETS_B64: \${{ secrets.JUROR_QA_SECRETS_B64 }}\n`;
  const digest = createHash('sha256').update(body).digest('hex');
  return `${MANAGED_PREFIX}${digest}\n${body}`;
}

export interface QaInitConfigOptions {
  targetUrl?: string | null;
  allowOrigins?: readonly string[];
}

interface NormalizedQaInitConfig {
  enabled: boolean;
  targetUrl: string | null;
  allowedOrigins: string[];
}

function normalizeQaInitConfig(options: QaInitConfigOptions = {}): NormalizedQaInitConfig {
  const targetUrl = options.targetUrl === null || options.targetUrl === undefined
    ? null
    : qaTargetUrl(options.targetUrl);
  const allowedOrigins: string[] = [];
  for (const raw of options.allowOrigins ?? []) {
    const origin = qaAllowedOrigin(raw);
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }
  if (targetUrl) {
    const targetOrigin = new URL(targetUrl).origin;
    if (!allowedOrigins.includes(targetOrigin)) allowedOrigins.unshift(targetOrigin);
  }
  if (allowedOrigins.length > 50) {
    throw new Error('QA setup accepts at most 50 distinct --allow-origin values, including the target origin');
  }
  return {
    enabled: targetUrl !== null || allowedOrigins.length > 0,
    targetUrl,
    allowedOrigins,
  };
}

function qaTargetUrl(raw: string): string {
  const parsed = parseSafeQaUrl(raw, '--target-url');
  return parsed.toString();
}

function qaAllowedOrigin(raw: string): string {
  const parsed = parseSafeQaUrl(raw, '--allow-origin');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`--allow-origin must be an exact HTTPS origin (or localhost HTTP): ${raw}`);
  }
  return parsed.origin;
}

function parseSafeQaUrl(raw: string, option: '--target-url' | '--allow-origin'): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${option} must be an absolute HTTPS URL without credentials, query, or fragment ` +
        `(or localhost HTTP): ${raw}`,
    );
  }
  const local = isLoopbackHostname(parsed.hostname);
  const secure = parsed.protocol === 'https:' || (local && parsed.protocol === 'http:');
  if (
    !secure ||
    !parsed.hostname ||
    parsed.hostname.includes('*') ||
    (parsed.protocol === 'https:' && isIpLiteralHostname(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${option} must be an absolute HTTPS URL without credentials, query, or fragment ` +
        `(or localhost HTTP): ${raw}`,
    );
  }
  return parsed;
}

export function renderQaConfigBlock(options: QaInitConfigOptions = {}): string {
  const normalized = normalizeQaInitConfig(options);
  const allowedOrigins = normalized.allowedOrigins.length === 0
    ? ['    allowed_origins: []']
    : [
        '    allowed_origins:',
        ...normalized.allowedOrigins.map((origin) => `      - ${JSON.stringify(origin)}`),
      ];
  return [
    'qa:',
    `  enabled: ${normalized.enabled}`,
    '  model:',
    '    id: gpt-5.6-luna',
    '    reasoning_effort: medium',
    '  testability:',
    '    early_exit_paths: []',
    '  target:',
    '    strategy: staging-first',
    '    environment: staging',
    '    deployment_environment: null',
    `    static_url: ${normalized.targetUrl === null ? 'null' : JSON.stringify(normalized.targetUrl)}`,
    '    readiness_path: /',
    '    readiness_statuses: null',
    '    commit_probe: null',
    '    preview_fallback: true',
    '    wait_seconds: 900',
    '  auth:',
    '    session_bootstrap: null',
    '    browser_secret_headers: []',
    '    steps: []',
    '  sandbox:',
    ...allowedOrigins,
    '    interaction_policy: disabled',
    '    reset: null',
    '  limits:',
    '    max_scenarios: 6',
    '    max_browser_operations: 40',
    '    timeout_seconds: 1200',
    '    mobile_when_relevant: true',
    '  evidence:',
    '    video: all',
    '    trace: failure',
    '    screenshot: failure',
    '    retention_days: 14',
    '',
  ].join('\n');
}

export function managedWorkflowIsPristine(text: string): boolean {
  const newline = text.indexOf('\n');
  if (newline < 0) return false;
  const first = text.slice(0, newline);
  if (!first.startsWith(MANAGED_PREFIX)) return false;
  const recorded = first.slice(MANAGED_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(recorded)) return false;
  const body = text.slice(newline + 1);
  const actual = createHash('sha256').update(body).digest('hex');
  return actual === recorded;
}

export async function installManagedWorkflow(
  repoDir: string,
  desired: string,
  dryRun: boolean,
  filename = 'juror.yml',
): Promise<WorkflowInstallResult> {
  const workflowPath = path.join(repoDir, '.github', 'workflows', filename);
  let existing: string | null = null;
  try {
    existing = await readFile(workflowPath, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (existing === desired) return { path: workflowPath, outcome: 'unchanged' };
  if (existing !== null && !managedWorkflowIsPristine(existing)) {
    return { path: workflowPath, outcome: 'preserved' };
  }
  if (dryRun) {
    return {
      path: workflowPath,
      outcome: existing === null ? 'planned-create' : 'planned-update',
    };
  }

  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, desired, { encoding: 'utf8', mode: 0o644 });
  return { path: workflowPath, outcome: existing === null ? 'created' : 'updated' };
}

export async function installQaConfig(
  repoDir: string,
  existingPath: string | null,
  dryRun: boolean,
  options: QaInitConfigOptions = {},
): Promise<WorkflowInstallResult> {
  const configPath = existingPath ?? path.join(repoDir, '.juror.yml');
  let existing: string | null = null;
  try {
    existing = await readFile(configPath, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing && /^qa\s*:/m.test(existing)) {
    return { path: configPath, outcome: 'unchanged' };
  }
  const desired = existing === null
    ? `version: 1\n\n${renderQaConfigBlock(options)}`
    : `${existing.trimEnd()}\n\n${renderQaConfigBlock(options)}`;
  if (dryRun) {
    return { path: configPath, outcome: existing === null ? 'planned-create' : 'planned-update' };
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, desired, { encoding: 'utf8', mode: 0o644 });
  return { path: configPath, outcome: existing === null ? 'created' : 'updated' };
}

export async function uploadProviderSecrets(
  env: Record<string, string | undefined>,
  canonicalNames: string[],
  repo: string,
  runner: CommandRunner = run,
): Promise<string[]> {
  const uploaded: string[] = [];
  const allowed = new Set<string>(PROVIDERS.map((provider) => provider.canonicalName));
  for (const canonicalName of canonicalNames) {
    if (!allowed.has(canonicalName)) {
      throw new Error(`Unsupported Juror provider secret ${JSON.stringify(canonicalName)}`);
    }
    const value = readSecret(env, canonicalName).value;
    if (!value) continue;
    const io = await runner(
      ['gh', 'secret', 'set', canonicalName, '--repo', repo],
      { stdin: value, timeoutMs: 120_000 },
    );
    if (io.exitCode !== 0) {
      // Do not include stdout/stderr: a failing third-party CLI is allowed to echo stdin.
      throw new Error(`Could not set GitHub secret ${canonicalName} (exit ${io.exitCode ?? 'unknown'})`);
    }
    uploaded.push(canonicalName);
  }
  return uploaded;
}

/**
 * Upload the opaque browser-auth bundle used only by post-merge QA.
 *
 * Init deliberately does not decode or validate this value. Decoding belongs to the trusted QA
 * controller at runtime; onboarding only detects the exact dedicated variable and sends its value
 * to GitHub over stdin after the caller has confirmed the upload.
 */
export async function uploadQaSecretsBundle(
  env: Record<string, string | undefined>,
  repo: string,
  runner: CommandRunner = run,
): Promise<string[]> {
  const value = env[QA_SECRETS_BUNDLE];
  if (typeof value !== 'string' || !value.trim()) return [];
  const io = await runner(
    ['gh', 'secret', 'set', QA_SECRETS_BUNDLE, '--repo', repo],
    { stdin: value, timeoutMs: 120_000 },
  );
  if (io.exitCode !== 0) {
    // Do not include stdout/stderr: a failing third-party CLI is allowed to echo stdin.
    throw new Error(`Could not set GitHub secret ${QA_SECRETS_BUNDLE} (exit ${io.exitCode ?? 'unknown'})`);
  }
  return [QA_SECRETS_BUNDLE];
}

export async function runInitCommand(options: InitCommandOptions): Promise<InitCommandResult> {
  const runner = options.runner ?? run;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const hasQaTargetOptions =
    (options.targetUrl !== null && options.targetUrl !== undefined) ||
    (options.allowOrigins?.length ?? 0) > 0;
  if (!options.qa && hasQaTargetOptions) {
    throw new Error('--target-url and --allow-origin are only meaningful with `juror init --qa`');
  }
  // Normalize before any writes so a malformed or unsafe target cannot leave a partial setup.
  const qaInitConfig = options.qa
    ? normalizeQaInitConfig({ targetUrl: options.targetUrl, allowOrigins: options.allowOrigins })
    : null;
  const root = await repoRoot(options.repoDir);
  const inside = await runner(['git', 'rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error(`juror init must run inside a git repository: ${root}`);
  }

  const repo = options.repo ?? (await inferRepository(root, runner));
  const gh = await inspectGh(runner);
  const defaultBranch = await detectDefaultBranch(root, repo, gh.authenticated, runner);
  const loaded = loadConfig(root);
  const config = options.preset ? applyReviewPreset(loaded.config, options.preset) : loaded.config;
  const readiness = credentialReadiness(options.env, config);
  const openAiCredentialAvailable = Boolean(readSecret(options.env, 'JUROR_OPENAI_API_KEY').value);
  if (options.qa && options.setSecrets && !openAiCredentialAvailable) {
    throw new Error(
      '--qa --set-secrets requires JUROR_OPENAI_API_KEY (or legacy OPENAI_API_KEY); ' +
        'the managed QA planner currently uses OpenAI',
    );
  }
  const availableNames = readiness.providers
    .filter((provider) => provider.available)
    .map((provider) => provider.canonicalName);
  // Browser credentials are independent from model-provider credentials and are considered only
  // for an explicitly requested QA install. Never decode, normalize, or print this opaque bundle.
  const qaSecretsBundleAvailable = options.qa && Boolean(options.env[QA_SECRETS_BUNDLE]?.trim());
  const uploadableSecretCount = availableNames.length + (qaSecretsBundleAvailable ? 1 : 0);

  write('Juror init\n\n');
  write(`Repository: ${repo ?? '(origin is not a GitHub repository)'}\n`);
  write(`Default branch: ${defaultBranch}\n`);
  write(`GitHub CLI: ${gh.installed ? (gh.authenticated ? `authenticated${gh.login ? ` as ${gh.login}` : ''}` : 'installed, not authenticated') : 'not installed'}\n`);
  write(`Config: ${loaded.sourcePath ? path.relative(root, loaded.sourcePath) : 'defaults (no .juror.yml found)'}\n`);
  if (options.preset) write(`Preset: ${options.preset} (CLI override)\n`);
  for (const problem of loaded.problems) write(`  ! Config warning: ${problem}\n`);
  for (const provider of readiness.providers) {
    write(
      `  ${provider.available ? '✓' : '·'} ${provider.label}: ` +
        `${provider.available ? `available via ${provider.source}` : `missing ${provider.canonicalName}`}\n`,
    );
  }
  if (options.qa) {
    write(
      `  ${qaSecretsBundleAvailable ? '✓' : '·'} QA browser auth: ` +
        `${qaSecretsBundleAvailable ? `available via ${QA_SECRETS_BUNDLE} (opaque; not inspected)` : `missing optional ${QA_SECRETS_BUNDLE}`}\n`,
    );
    if (!openAiCredentialAvailable) {
      write(
        '  · QA planner: missing JUROR_OPENAI_API_KEY (or OPENAI_API_KEY); ' +
          'configure it before managed QA can run\n',
      );
    }
  }
  write(`${jurySummary(readiness)}\n`);

  let secretUploadConfirmed = false;
  if (options.setSecrets && !options.dryRun) {
    if (!repo) throw new Error('--set-secrets needs a GitHub origin or --repo owner/name');
    if (!gh.installed || !gh.authenticated) {
      throw new Error('--set-secrets needs an authenticated GitHub CLI; run `gh auth login` first');
    }
    if (uploadableSecretCount === 0) {
      throw new Error(
        options.qa
          ? `--set-secrets found no provider keys or ${QA_SECRETS_BUNDLE}; add them to the environment or repo .env first`
          : '--set-secrets found no provider keys; add them to the environment or repo .env first',
      );
    }
    secretUploadConfirmed = options.yes || await (options.confirm ?? confirmInTerminal)(
      `Upload ${uploadableSecretCount} detected Juror secret(s) to ${repo}` +
        `${qaSecretsBundleAvailable ? `, including the opaque ${QA_SECRETS_BUNDLE} browser-auth bundle` : ''}?`,
    );
  }
  const actionSha = await resolveActionSha(options.actionSha, options.version, runner);
  const workflowText = renderManagedWorkflow({ actionSha, version: options.version, preset: options.preset });
  const workflow = await installManagedWorkflow(root, workflowText, options.dryRun ?? false);
  write(`${workflowSummary(workflow, root)}\n`);
  let qaWorkflow: WorkflowInstallResult | null = null;
  let qaConfig: WorkflowInstallResult | null = null;
  if (options.qa) {
    qaWorkflow = await installManagedWorkflow(
      root,
      renderManagedQaWorkflow({ actionSha, version: options.version }),
      options.dryRun ?? false,
      'juror-qa.yml',
    );
    qaConfig = await installQaConfig(
      root,
      loaded.sourcePath,
      options.dryRun ?? false,
      { targetUrl: options.targetUrl, allowOrigins: options.allowOrigins },
    );
    write(`QA ${workflowSummary(qaWorkflow, root)}\n`);
    write(`QA config: ${path.relative(root, qaConfig.path)} (${qaConfig.outcome})\n`);
    const existingQaPolicyPreserved = qaConfig.outcome === 'unchanged';
    const effectiveEnabled = existingQaPolicyPreserved
      ? config.qa.enabled
      : qaInitConfig?.enabled ?? false;
    const effectiveOrigins = existingQaPolicyPreserved
      ? config.qa.sandbox.allowed_origins
      : qaInitConfig?.allowedOrigins ?? [];
    if (existingQaPolicyPreserved && hasQaTargetOptions) {
      write(
        'QA target flags were not applied because the existing qa block is user-managed; ' +
          `edit ${path.relative(root, qaConfig.path)} directly.\n`,
      );
    }
    if (!effectiveEnabled) {
      if (existingQaPolicyPreserved) {
        write(
          `QA remains disabled by the existing user-managed qa block in ${path.relative(root, qaConfig.path)}. ` +
            'Review its target and exact allowed origins, then set `qa.enabled: true`.\n',
        );
      } else {
        write(
          'QA remains disabled because no target URL or allowed origin is configured. ' +
            'Re-run `juror init --qa --target-url https://staging.example.com` or edit the qa block, ' +
            'then set `qa.enabled: true`.\n',
        );
      }
    } else if (effectiveOrigins.length === 0) {
      write(
        'QA is enabled but has no allowed browser origin. Add an exact HTTPS origin under ' +
          '`qa.sandbox.allowed_origins` before the workflow runs.\n',
      );
    } else {
      write(`QA target policy enabled for ${effectiveOrigins.length} exact browser origin(s).\n`);
      const resetConfigured = existingQaPolicyPreserved && config.qa.sandbox.reset !== null;
      const readOnlyInteractionsConfigured = existingQaPolicyPreserved
        && config.qa.sandbox.interaction_policy === 'read_only';
      if (!resetConfigured && !readOnlyInteractionsConfigured) {
        write(
          'QA starts in navigation-only mode. Set qa.sandbox.interaction_policy to read_only ' +
            'for network-guarded UI actions, or configure a trusted qa.sandbox.reset hook ' +
            'for persistent mutations.\n',
        );
      } else if (!resetConfigured) {
        write('QA read-only UI interactions are enabled with controller network write barriers.\n');
      }
    }
  }

  let uploadedSecrets: string[] = [];
  if (options.setSecrets) {
    if (options.dryRun) {
      write(`Dry run: would upload ${uploadableSecretCount} detected Juror secret(s); no values were sent.\n`);
    } else {
      if (secretUploadConfirmed) {
        if (!repo) throw new Error('internal init error: confirmed secret upload has no repository');
        uploadedSecrets = await uploadProviderSecrets(options.env, availableNames, repo, runner);
        if (options.qa) {
          uploadedSecrets.push(...await uploadQaSecretsBundle(options.env, repo, runner));
        }
        write(`Uploaded ${uploadedSecrets.length} Juror secret(s) using dedicated JUROR_ names.\n`);
      } else {
        write('Secret upload skipped. No credential values were sent.\n');
      }
    }
  } else if (uploadableSecretCount > 0) {
    write('Secrets were not uploaded. Re-run with --set-secrets to confirm and upload detected values.\n');
  }

  if (options.dryRun) write('Dry run complete: no workflow or secret was changed.\n');
  else if (workflow.outcome === 'preserved') {
    write('Existing workflow has user changes and was preserved; merge the generated setup manually.\n');
  } else {
    write(`Next: review and commit ${path.relative(root, workflow.path)} and open a pull request.\n`);
    write(
      `First local review (uses provider APIs): juror review` +
        `${options.preset ? ` --preset ${options.preset}` : ''} --base ${defaultBranch}\n`,
    );
  }
  if (!options.dryRun && options.qa && qaWorkflow && qaConfig) {
    write(
      `QA setup: review and commit ${humanList([
        path.relative(root, qaWorkflow.path),
        path.relative(root, qaConfig.path),
      ])}.\n`,
    );
    write(
      `Post-merge QA is opt-in through ${path.relative(root, qaConfig.path)} and, when enabled, runs from ` +
        `${path.relative(root, qaWorkflow.path)} after a same-repository PR merges to ${defaultBranch}.\n`,
    );
    if (!qaSecretsBundleAvailable) {
      write(
        `Browser login is optional. When configured, set the opaque ${QA_SECRETS_BUNDLE} ` +
          'base64 JSON map before re-running with --qa --set-secrets.\n',
      );
    }
  }

  return {
    repoDir: root,
    repo,
    defaultBranch,
    ghInstalled: gh.installed,
    ghAuthenticated: gh.authenticated,
    configPath: loaded.sourcePath,
    actionSha,
    readiness,
    workflow,
    qaWorkflow,
    qaConfig,
    uploadedSecrets,
  };
}

async function inferRepository(repoDir: string, runner: CommandRunner): Promise<string | null> {
  const io = await runner(['git', 'remote', 'get-url', 'origin'], { cwd: repoDir, timeoutMs: 30_000 });
  if (io.exitCode !== 0) return null;
  const match = io.stdout.trim().match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

async function inspectGh(runner: CommandRunner): Promise<{ installed: boolean; authenticated: boolean; login: string | null }> {
  const found = await runner(['/usr/bin/env', 'which', 'gh'], { timeoutMs: 10_000 });
  if (found.exitCode !== 0) return { installed: false, authenticated: false, login: null };
  const auth = await runner(['gh', 'auth', 'status'], { timeoutMs: 30_000 });
  if (auth.exitCode !== 0) return { installed: true, authenticated: false, login: null };
  const user = await runner(['gh', 'api', 'user', '--jq', '.login'], { timeoutMs: 30_000 });
  return {
    installed: true,
    authenticated: true,
    login: user.exitCode === 0 ? user.stdout.trim() || null : null,
  };
}

async function detectDefaultBranch(
  repoDir: string,
  repo: string | null,
  ghAuthenticated: boolean,
  runner: CommandRunner,
): Promise<string> {
  if (repo && ghAuthenticated) {
    const remote = await runner(
      ['gh', 'repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { timeoutMs: 30_000 },
    );
    if (remote.exitCode === 0 && remote.stdout.trim()) return remote.stdout.trim();
  }
  const originHead = await runner(
    ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: repoDir, timeoutMs: 30_000 },
  );
  if (originHead.exitCode === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, '');
  }
  const current = await runner(['git', 'branch', '--show-current'], { cwd: repoDir, timeoutMs: 30_000 });
  return current.exitCode === 0 && current.stdout.trim() ? current.stdout.trim() : 'main';
}

async function resolveActionSha(
  explicit: string | null | undefined,
  version: string,
  runner: CommandRunner,
): Promise<string> {
  if (explicit) {
    assertActionSha(explicit);
    return explicit.toLowerCase();
  }

  const ref = `v${version}`;
  const gh = await runner(
    ['gh', 'api', `repos/${ACTION_REPOSITORY}/commits/${ref}`, '--jq', '.sha'],
    { timeoutMs: 30_000 },
  ).catch(() => null);
  const fromGh = gh?.exitCode === 0 ? gh.stdout.trim() : '';
  if (/^[a-f0-9]{40}$/i.test(fromGh)) return fromGh.toLowerCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${ACTION_REPOSITORY}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `juror-init/${version}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      },
    );
    if (response.ok) {
      const payload = await response.json() as { sha?: unknown };
      if (typeof payload.sha === 'string' && /^[a-f0-9]{40}$/i.test(payload.sha)) {
        return payload.sha.toLowerCase();
      }
    }
  } catch {
    // The actionable error below covers offline, timeout, and malformed response cases.
  } finally {
    clearTimeout(timer);
  }
  throw new Error(
    `Could not resolve immutable action revision ${ref}; connect to GitHub or pass --action-sha <40-hex-sha>`,
  );
}

function assertActionSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`Action revision must be a full 40-character commit SHA, got ${JSON.stringify(value)}`);
  }
}

function jurySummary(readiness: CredentialReadiness): string {
  if (readiness.juryKind === 'multi-model') {
    return `Jury: ${readiness.runnableModels.length} runnable models across ${readiness.runnableFamilies.length} families — multi-model review ready.`;
  }
  if (readiness.juryKind === 'single-model') {
    return `Jury: ${readiness.runnableModels.length} runnable model from one family — single-model review works, but there is no cross-model agreement signal.`;
  }
  return 'Jury: no configured model can authenticate — add a key used by the selected preset before reviewing.';
}

function workflowSummary(workflow: WorkflowInstallResult, repoDir: string): string {
  const relative = path.relative(repoDir, workflow.path) || workflow.path;
  const descriptions: Record<WorkflowInstallResult['outcome'], string> = {
    created: 'created',
    updated: 'updated',
    unchanged: 'already current',
    preserved: 'preserved because it is unmanaged or user-modified',
    'planned-create': 'would be created',
    'planned-update': 'would be updated',
  };
  return `Workflow: ${relative} ${descriptions[workflow.outcome]} (Juror is pinned to an immutable SHA).`;
}

function humanList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

async function confirmInTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation is unavailable; re-run with --set-secrets --yes to confirm explicitly');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
