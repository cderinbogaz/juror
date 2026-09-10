#!/usr/bin/env node
/**
 * `juror` — the same binary in CI and on your laptop.
 *
 * There is exactly one code path: collect a diff, fan out, deduplicate, filter, render.
 * Whether the result is printed to a terminal or posted to a pull request is decided at
 * the very end, which is what keeps "works locally" and "works in Actions" from drifting.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';

import { run, runOrThrow } from './util/proc.js';

import type { DiffContext, JurorConfig, ReviewPreset } from './types.js';
import {
  applyReviewPreset,
  loadConfig,
  parseReviewPreset,
  readSecret,
  resolveModelRuntime,
  REVIEW_PRESETS,
} from './config.js';
import { collectFromPatch, collectLocalDiff } from './diff/collect.js';
import { runReview } from './review.js';
import { renderTerminalReport } from './render/terminal.js';
import { renderSummaryComment } from './render/summary.js';
import { GitHubClient, type GitHubFetch, type PullMeta } from './github/client.js';
import { publishFailureComment, publishReview, publishWorkingComment } from './github/publish.js';
import { loadRolling, recordSpend } from './cost/rolling.js';
import { log, redact, setLogLevel } from './util/log.js';
import { gitStateDir, repoRoot } from './util/workspace.js';
import {
  checkoutAt,
  type CheckoutPromisorAccess,
  type EphemeralCheckout,
} from './util/worktree.js';
import { evaluateBenchmark, parseBenchmarkCorpus, renderBenchmark } from './benchmark.js';
import { loadAgentInstructions } from './instructions.js';
import { runInitCommand } from './init.js';
import {
  checkedQaOutput,
  decodeQaSecrets,
  prepareQaEvidenceDirectory,
  runQa,
  serializeQaReport,
} from './qa/run.js';
import {
  finalizeQaEvidence,
  markQaInfrastructureError,
  normalizeQaArtifactUrl,
} from './qa/finalize.js';
import { isQaRunResult } from './qa/result-validator.js';
import type { QaRunResult } from './qa/types.js';
import { qaExactOrigin, qaGitHubServerOrigin, qaServiceOrigins } from './qa/network.js';
import {
  loadConfigFromBase,
  loadQaConfigConsensusFromBases,
} from './qa/trusted-config.js';
import { containsQaPresentationSecret, renderQaSummary } from './render/qa-summary.js';
import { publishQaPending, publishQaResult, qaPublicationAllowed } from './github/publish-qa.js';
import { resolveMergedPull } from './github/merged-pull.js';

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
    throw new Error('Juror package metadata has no version');
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Juror package metadata has an invalid version');
  }
  return version;
}

export const VERSION = packageVersion();
const QA_MAX_DIFF_BYTES = 10_000_000;
const QA_MAX_CHANGED_PATH_BYTES = 200_000;

const USAGE = `
juror ${VERSION} — multi-model PR review that shows you the bill

Usage
  juror init [options]
  juror review [options]
  juror qa --pr <number> [options]
  juror qa-policy --pr <number> [options]
  juror qa-finalize --report <path> [options]
  juror qa-publish-final --report <path> [options]
  juror benchmark --file <corpus.json> [--json [path]]

Target (pick one)
  --pr <number>          Review a GitHub pull request
  --base <ref>           Review the local working tree against a base ref (default: origin/HEAD)

Options
  --repo <owner/name>    GitHub repository (default: inferred from the git remote)
  --repo-dir <path>      Repository checkout to read (default: cwd)
  --head <ref>           Head ref for local mode (default: HEAD)
  --config <path>        Config file (default: .juror.yml in the repo)
  --preset <name>        Jury preset: starter (one OpenRouter key), fast (default), balanced, high, or ultra
  --mode <name>          Alias for --preset
  --models <a,b,c>       Only run these model ids
  --post                 Post the review to the pull request (requires --pr and GITHUB_TOKEN)
  --post-pending         QA finalizer: post a non-final artifact-pending result
  --dry-run              Init: validate without writes. Review: with --post, do not publish
  --json [path]          Emit the full ReviewResult as JSON (stdout, or a file)
  --markdown <path>      Write the rendered summary comment to a file
  --cost-target <usd>    Override budget.target_cost_usd_per_pr (planning target, not a hard cap)
  --keep-scratch         Keep the unique temporary run directory for debugging
  --env-file <path>      Load credentials before running; QA requires an explicit file outside the tested repo
  --file <path>          Adjudicated corpus for the benchmark command
  --target-url <url>     QA/init: explicit staging/preview URL
  --target-sha <sha>     QA: deployed 40-character SHA for revision verification
  --allow-origin <url>   QA/init: allow an additional exact browser origin (repeatable)
  --evidence-dir <path>  QA: videos, traces, plan, and report output directory
  --report <path>        QA finalizer: controller-owned report to finalize after artifact upload
  --artifact-name <name> QA finalizer: uploaded Actions artifact name
  --artifact-url <url>   QA finalizer: uploaded Actions artifact URL
  --artifact-upload-error <text>
                         QA finalizer: classify the run as an infrastructure error
  --finalization-error <text>
                         QA finalizer: record a later infrastructure failure
  --storage-state <path> QA: trusted Playwright auth state for local iteration
  --headed               QA: show Chromium instead of running headless
  --force                QA: run locally even when qa.enabled is false
  -v, --verbose          Debug logging
  -q, --quiet            Errors only
  -h, --help             This message

Init
  --qa                   Install the separate post-merge QA workflow and config
  --set-secrets          After confirmation, upload detected keys using dedicated JUROR_ names
  --yes                  Confirm --set-secrets non-interactively
  --action-sha <sha>     Pin this full 40-character Juror Action SHA instead of resolving v${VERSION}

Environment
  JUROR_ANTHROPIC_API_KEY  JUROR_OPENAI_API_KEY  JUROR_XAI_API_KEY  JUROR_FIREWORKS_API_KEY
  JUROR_OPENROUTER_API_KEY  JUROR_SCALEWAY_API_KEY
  The unprefixed names (ANTHROPIC_API_KEY, …) still work as a fallback. Prefer the
  prefixed ones and give Juror its own provider key, so review spend is billed and
  tracked separately from everything else that account does.
  GITHUB_TOKEN
  JUROR_LOG_LEVEL          debug | info | warn | error | silent (default: info).
                           Unrecognized values fall back to info with a one-time warning.
  Any model whose key is absent is skipped with a note in the receipt — a repo with one
  key still gets a working review.
`;

interface Args {
  command: string;
  pr: number | null;
  repo: string | null;
  repoDir: string;
  base: string | null;
  head: string | null;
  config: string | null;
  preset: ReviewPreset | null;
  models: string[];
  post: boolean;
  postPending: boolean;
  dryRun: boolean;
  json: string | boolean;
  markdown: string | null;
  costTarget: number | null;
  keepScratch: boolean;
  envFile: string | null;
  file: string | null;
  setSecrets: boolean;
  yes: boolean;
  actionSha: string | null;
  qa: boolean;
  targetUrl: string | null;
  targetSha: string | null;
  allowOrigins: string[];
  evidenceDir: string | null;
  report: string | null;
  artifactName: string | null;
  artifactUrl: string | null;
  artifactUploadError: string | null;
  finalizationError: string | null;
  storageState: string | null;
  headed: boolean;
  forceQa: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: 'review',
    pr: null,
    repo: null,
    repoDir: process.cwd(),
    base: null,
    head: null,
    config: null,
    preset: null,
    models: [],
    post: false,
    postPending: false,
    dryRun: false,
    json: false,
    markdown: null,
    costTarget: null,
    keepScratch: false,
    envFile: null,
    file: null,
    setSecrets: false,
    yes: false,
    actionSha: null,
    qa: false,
    targetUrl: null,
    targetSha: null,
    allowOrigins: [],
    evidenceDir: null,
    report: null,
    artifactName: null,
    artifactUrl: null,
    artifactUploadError: null,
    finalizationError: null,
    storageState: null,
    headed: false,
    forceQa: false,
    help: false,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) a.command = rest.shift() as string;

  const next = (i: number): string => {
    const v = rest[i + 1];
    if (v === undefined) throw new Error(`Missing value for ${rest[i]}`);
    return v;
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--pr': a.pr = Number(next(i)); i++; break;
      case '--repo': a.repo = next(i); i++; break;
      case '--repo-dir': a.repoDir = path.resolve(next(i)); i++; break;
      case '--base': a.base = next(i); i++; break;
      case '--head': a.head = next(i); i++; break;
      case '--config': a.config = path.resolve(next(i)); i++; break;
      case '--preset':
      case '--mode': {
        const value = next(i);
        const preset = parseReviewPreset(value);
        if (!preset) throw new Error(`Unknown preset "${value}". Expected one of: ${REVIEW_PRESETS.join(', ')}`);
        a.preset = preset;
        i++;
        break;
      }
      case '--models': a.models = next(i).split(','); i++; break;
      case '--post': a.post = true; break;
      case '--post-pending': a.postPending = true; break;
      case '--no-post': a.post = false; break;
      case '--dry-run': a.dryRun = true; break;
      case '--markdown': a.markdown = path.resolve(next(i)); i++; break;
      case '--cost-target': a.costTarget = Number(next(i)); i++; break;
      case '--keep-scratch': a.keepScratch = true; break;
      case '--env-file': a.envFile = path.resolve(next(i)); i++; break;
      case '--file': a.file = path.resolve(next(i)); i++; break;
      case '--set-secrets': a.setSecrets = true; break;
      case '--yes': a.yes = true; break;
      case '--action-sha': a.actionSha = next(i); i++; break;
      case '--qa': a.qa = true; break;
      case '--target-url': a.targetUrl = next(i); i++; break;
      case '--target-sha': a.targetSha = next(i); i++; break;
      case '--allow-origin': a.allowOrigins.push(next(i)); i++; break;
      case '--evidence-dir': a.evidenceDir = path.resolve(next(i)); i++; break;
      case '--report': a.report = path.resolve(next(i)); i++; break;
      case '--artifact-name': a.artifactName = next(i); i++; break;
      case '--artifact-url': a.artifactUrl = next(i); i++; break;
      case '--artifact-upload-error': a.artifactUploadError = next(i); i++; break;
      case '--finalization-error': a.finalizationError = next(i); i++; break;
      case '--storage-state': a.storageState = path.resolve(next(i)); i++; break;
      case '--headed': a.headed = true; break;
      case '--force': a.forceQa = true; break;
      case '--json': {
        const v = rest[i + 1];
        if (v && !v.startsWith('-')) { a.json = path.resolve(v); i++; } else a.json = true;
        break;
      }
      case '-v': case '--verbose': setLogLevel('debug'); break;
      case '-q': case '--quiet': setLogLevel('error'); break;
      case '-h': case '--help': a.help = true; break;
      case '--version': process.stdout.write(`${VERSION}\n`); process.exit(0);
      default:
        if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    }
  }
  return a;
}

/**
 * Minimal `.env` loader. A dependency for this would be silly, and keeping it in-tree means
 * the file format is whatever we say it is: `KEY=VALUE`, `#` comments, optional quotes.
 */
function loadEnvFile(file: string, allowedKeys?: ReadonlySet<string>): number {
  if (!existsSync(file)) return 0;
  let n = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (allowedKeys && !allowedKeys.has(key))) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && process.env[key] === undefined) {
      process.env[key] = val;
      n++;
    }
  }
  return n;
}

const QA_ENV_FILE_KEYS = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'JUROR_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'JUROR_QA_SECRETS_B64',
]);

function loadQaEnvFile(file: string | null, repoDir: string): number {
  if (!file) return 0;
  const lexicalFile = path.resolve(file);
  let resolvedFile: string;
  const physicalPrefixes: string[] = [];
  try {
    resolvedFile = realpathSync(lexicalFile);
    // Resolve every traversed component, not only the final file and its parent. An arbitrary
    // outside alias can enter the repository and then follow a repository-owned directory
    // symlink back out; its endpoints are both outside, but the credential path is still
    // controlled by the tested checkout.
    const root = path.parse(lexicalFile).root;
    let prefix = root;
    for (const component of lexicalFile.slice(root.length).split(path.sep).filter(Boolean)) {
      prefix = path.join(prefix, component);
      physicalPrefixes.push(realpathSync(prefix));
    }
  } catch {
    throw new Error(`QA environment file does not exist: ${file}`);
  }
  const lexicalRepo = path.resolve(repoDir);
  const physicalRepo = realpathSync(repoDir);
  const inside = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative === '' || (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  if (
    [lexicalFile, resolvedFile, ...physicalPrefixes].some((candidate) =>
      inside(lexicalRepo, candidate) || inside(physicalRepo, candidate),
    )
  ) {
    throw new Error('QA refuses to load an environment file from the tested repository; use an operator-owned file outside it');
  }
  return loadEnvFile(resolvedFile, QA_ENV_FILE_KEYS);
}

async function inferRepo(repoDir: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const url = (await runOrThrow(['git', 'remote', 'get-url', 'origin'], {
      cwd: repoDir,
      ...(signal ? { signal } : {}),
    })).trim();
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return m?.[1] && m[2] ? `${m[1]}/${m[2]}` : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === 'init') {
    if (args.yes && !args.setSecrets) {
      throw new Error('--yes is only meaningful with `juror init --set-secrets`');
    }
    if (!args.qa && (args.targetUrl || args.allowOrigins.length > 0)) {
      throw new Error('--target-url and --allow-origin with `juror init` require --qa');
    }
    const initRepoDir = await repoRoot(args.repoDir);
    const loaded = loadEnvFile(args.envFile ?? path.join(initRepoDir, '.env'));
    if (loaded) log.debug(`loaded ${loaded} variable(s) from the env file`);
    await runInitCommand({
      repoDir: initRepoDir,
      repo: args.repo,
      env: process.env as Record<string, string | undefined>,
      version: VERSION,
      actionSha: args.actionSha,
      preset: args.preset,
      dryRun: args.dryRun,
      setSecrets: args.setSecrets,
      yes: args.yes,
      qa: args.qa,
      targetUrl: args.targetUrl,
      allowOrigins: args.allowOrigins,
    });
    return 0;
  }
  if (args.command === 'benchmark') return runBenchmarkCommand(args);
  if (args.command === 'qa') return runQaCommand(args);
  if (args.command === 'qa-policy') return runQaPolicyCommand(args);
  if (args.command === 'qa-finalize') return runQaFinalizeCommand(args);
  if (args.command === 'qa-publish-final') return runQaPublishFinalCommand(args);
  if (args.command !== 'review') {
    process.stderr.write(`Unknown command "${args.command}".\n${USAGE}`);
    return 2;
  }

  const repoDir = await repoRoot(args.repoDir);
  const loaded = loadEnvFile(args.envFile ?? path.join(repoDir, '.env'));
  if (loaded) log.debug(`loaded ${loaded} variable(s) from the env file`);
  if (args.costTarget !== null && (!Number.isFinite(args.costTarget) || args.costTarget < 0)) {
    throw new Error('--cost-target must be a finite number greater than or equal to zero');
  }

  const repo = args.repo ?? (await inferRepo(repoDir));
  const prNumber: number | null = args.pr;
  let githubClient: GitHubClient | null = null;
  let githubAccessToken: string | null = null;
  let pull: PullMeta | null = null;

  if (prNumber !== null) {
    if (!repo) throw new Error('--pr needs a repository: pass --repo owner/name');
    githubAccessToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
    if (!githubAccessToken) throw new Error('--pr needs GITHUB_TOKEN (read access is enough without --post)');
    githubClient = new GitHubClient({ token: githubAccessToken, repo, version: VERSION });
    pull = await githubClient.getPull(prNumber);
    log.step(`PR #${pull.number} — ${pull.title}`);
  }

  // In PR mode, repository configuration is untrusted until read from the base revision.
  // An explicit path inside the repo is also read from base; only an external operator-owned
  // config file is read directly.
  const loadedConfig = pull
    ? await loadConfigFromBase(
        repoDir,
        pull.baseSha,
        args.config,
        githubPromisorAccess(repo!, githubAccessToken!),
      )
    : loadConfig(repoDir, args.config ?? undefined);
  const { config: baseConfig, problems, sourcePath } = loadedConfig;
  for (const p of problems) log.warn(`config: ${p}`);
  if (sourcePath) log.debug(`config from ${sourcePath}`);

  let config: JurorConfig = args.preset ? applyReviewPreset(baseConfig, args.preset) : baseConfig;
  if (args.costTarget !== null) {
    config = { ...config, budget: { ...config.budget, target_cost_usd_per_pr: args.costTarget } };
  }

  // ── Collect the diff ───────────────────────────────────────────────────────
  let diff: DiffContext;
  let headSha: string;
  let checkout: EphemeralCheckout = {
    dir: repoDir,
    ephemeral: false,
    diffFrom: async () => {
      throw new Error('The source checkout cannot produce an isolated committed diff');
    },
    changedPathsFrom: async () => {
      throw new Error('The source checkout cannot produce an isolated changed-path manifest');
    },
    seal: async () => {},
    cleanup: async () => {},
  };

  if (pull && githubClient && prNumber !== null) {
    const patch = await githubClient.getCompareDiff(pull.baseSha, pull.headSha);
    diff = collectFromPatch(patch, {
      baseSha: pull.baseSha,
      headSha: pull.headSha,
      pathsIgnore: config.review.paths_ignore,
      maxDiffBytes: config.review.max_diff_bytes,
    });
    headSha = pull.headSha;
    // Reviewing a PR means grepping an isolated PR-head worktree, never whatever branch or
    // untracked secret files happen to be present in the operator checkout.
    checkout = await checkoutAt(repoDir, pull.headSha, {
      prNumber,
      promisor: githubPromisorAccess(githubClient.repo, githubAccessToken!),
      requiredCommits: [diff.baseSha],
    });
  } else {
    diff = await collectLocalDiff({
      repoDir,
      ...(args.base ? { base: args.base } : {}),
      ...(args.head ? { head: args.head } : {}),
      pathsIgnore: config.review.paths_ignore,
      maxDiffBytes: config.review.max_diff_bytes,
    });
    headSha = diff.headSha;
    // A commit-to-commit review needs only the detached head. Without --head, reproduce
    // staged and unstaged tracked changes inside that clean view; untracked files (including
    // `.env`) are neither part of the collected diff nor copied into the model read root.
    checkout = await checkoutAt(repoDir, headSha, { includeWorkingTree: !args.head });
  }

  // Load policy while the detached worktree still has repository metadata, then sever its
  // `.git` pointer before any model can read the checkout. That pointer can lead back to an
  // Actions credential-bearing git config even though the source tree itself is clean.
  const instructions = await loadAgentInstructions(
    checkout.dir,
    diff.baseSha,
    diff.files.filter((file) => !file.ignored).map((file) => file.path),
  );
  await checkout.seal();

  const reviewable = diff.files.filter((f) => !f.ignored);
  if (reviewable.length === 0) {
    log.warn('Nothing to review: the diff is empty after path filters.');
  } else {
    log.step(
      `${reviewable.length} file${reviewable.length === 1 ? '' : 's'} · ` +
        `+${diff.totalAdditions}/-${diff.totalDeletions} · base ${diff.baseSha.slice(0, 7)}`,
    );
  }

  // ── Review ─────────────────────────────────────────────────────────────────
  const progress = args.post && prNumber !== null && repo && githubClient
    ? {
        client: githubClient,
        prNumber,
        headSha,
        version: VERSION,
        modelLabels: runnableModelLabels(config, args.models, process.env),
        jobUrl: actionRunUrl(repo),
        dryRun: args.dryRun,
      }
    : null;

  let workingCommentPosted = false;
  let failureCommentPosted = false;
  const markFailed = async (reason: string): Promise<void> => {
    if (!progress || !workingCommentPosted || failureCommentPosted) return;
    failureCommentPosted = true;
    try {
      await publishFailureComment({ ...progress, reason });
    } catch (statusError) {
      log.warn(`could not update the failed working comment: ${errorMessage(statusError)}`);
    }
  };

  // A review is minutes of model time, so Ctrl-C during one is normal. Abort the active
  // harnesses first, let runReview settle, and only then leave through the ordinary cleanup
  // path; exiting directly from the signal handler would orphan provider processes.
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | null = null;
  let signalNotice: Promise<void> | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (receivedSignal) return;
    receivedSignal = sig;
    controller.abort();
    signalNotice = markFailed(`Review cancelled by ${sig}.`);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result: Awaited<ReturnType<typeof runReview>>;
  try {
    if (progress) {
      try {
        workingCommentPosted = (await publishWorkingComment(progress)) !== null;
      } catch (e) {
        log.warn(`could not post the working comment: ${errorMessage(e)}`);
      }
    }
    result = await runReview({
      repoDir: checkout.dir,
      config,
      diff,
      secrets: process.env as Record<string, string | undefined>,
      ...(args.models.length ? { onlyModels: args.models } : {}),
      keepScratch: args.keepScratch,
      signal: controller.signal,
      instructions,
      ...(pull ? { pullRequest: { title: pull.title, body: pull.body } } : {}),
    });
  } catch (e) {
    await markFailed(errorMessage(e));
    throw e;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!args.keepScratch) await checkout.cleanup();
    else if (checkout.ephemeral) log.info(`worktree kept at ${checkout.dir}`);
  }

  if (receivedSignal) {
    await signalNotice;
    return receivedSignal === 'SIGINT' ? 130 : 143;
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  const stateDir = await gitStateDir(repoDir);
  const prKey = `${repo ?? 'local'}#${prNumber ?? 'wt'}@${headSha.slice(0, 12)}`;
  const rolling = safeRecordSpend(
    stateDir,
    result.totals.partial ? null : result.totals.usd,
    prKey,
  );

  if (args.json !== true) process.stdout.write(renderTerminalReport(result, { version: VERSION }));

  if (args.post) {
    if (prNumber === null || !repo || !githubClient) {
      log.error('--post requires --pr and a resolvable repository');
      return 2;
    }
    let outcome;
    let current: PullMeta | null = null;
    try {
      // A synchronize event normally cancels this job, but cancellation is advisory: a
      // provider call or network request may finish first. Never let that stale run replace
      // the new head's sticky comment or attach findings to an obsolete commit.
      current = await githubClient.getPull(prNumber);
    } catch (e) {
      // Fail closed without touching the sticky: it may already belong to a newer run, and
      // a failed freshness request gives us no safe way to distinguish that case.
      log.warn(
        `Could not confirm PR #${prNumber}'s current head; the completed review was not posted: ` +
          errorMessage(e),
      );
    }

    if (current) {
      const snapshotChanged = current.headSha !== headSha || current.baseSha !== diff.baseSha;
      if (snapshotChanged) {
        log.warn(
          `PR #${prNumber} changed during review; completed snapshot ${headSha.slice(0, 12)} ` +
            'was not posted because a fresh run must review the current head.',
        );
        outcome = null;
      } else {
        try {
          outcome = await publishReview(result, {
            client: githubClient,
            prNumber,
            headSha,
            config,
            version: VERSION,
            rolling,
            dryRun: args.dryRun,
          });
        } catch (e) {
          await markFailed(`Publishing the completed review failed: ${errorMessage(e)}`);
          throw e;
        }
      }
    }
    if (outcome) {
      for (const w of outcome.warnings) log.warn(w);
      log.info(
        args.dryRun
          ? 'dry run: nothing was posted'
          : `posted — summary comment ${outcome.summaryCommentId}, ${outcome.inlinePosted} inline`,
      );
    }
  }

  if (args.markdown) {
    const md = renderSummaryComment(result, {
      version: VERSION,
      headSha,
      config,
      rolling,
      ...(repo ? { repo } : {}),
      ...(prNumber !== null ? { prNumber } : {}),
    });
    await writeFile(args.markdown, redact(md), 'utf8');
    log.info(`summary written to ${args.markdown}`);
  }

  if (args.json) {
    const payload = JSON.stringify(serializable(result), null, 2);
    if (typeof args.json === 'string') await writeFile(args.json, payload, 'utf8');
    else process.stdout.write(`${payload}\n`);
  }

  // A review that found blockers is still a successful review. Exit non-zero only when the
  // tool itself failed, so a PR check can decide policy separately from tool health.
  return 0;
}

async function githubToken(signal?: AbortSignal): Promise<string | null> {
  const direct = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (direct) return direct;
  const fromGh = await run(['gh', 'auth', 'token'], {
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  }).catch(() => null);
  signal?.throwIfAborted();
  return fromGh?.exitCode === 0 ? fromGh.stdout.trim() || null : null;
}

function githubPromisorAccess(repo: string, token: string): CheckoutPromisorAccess {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('Promisor repository must be owner/name');
  const root = qaGitHubServerOrigin(process.env.GITHUB_SERVER_URL);
  const repositoryPath = repo.split('/').map(encodeURIComponent).join('/');
  return { url: `${root}/${repositoryPath}.git`, token };
}

function assertQaPullRepository(pull: PullMeta, requestedRepo: string): void {
  const expected = requestedRepo.toLowerCase();
  const base = pull.baseRepo.trim().toLowerCase();
  const head = pull.headRepo.trim().toLowerCase();
  if (!base || !head || base !== expected || head !== expected) {
    throw new Error(
      `PR #${pull.number} has missing or mismatched repository identity; ` +
        'post-merge QA accepts only same-repository pull requests',
    );
  }
}

/**
 * The local bootstrap request runs before the container and its egress proxy exist. Give slow
 * developer/VPN routes a realistic connection budget while keeping the production GitHub client
 * transport injectable and ensuring the dedicated socket pool is always closed.
 */
function qaPolicyTransport(): { fetchImpl: GitHubFetch; close: () => Promise<void> } {
  const dispatcher = new UndiciAgent({ connect: { timeout: 60_000 } });
  const fetchImpl: GitHubFetch = async (input, init) => (
    await undiciFetch(input as string | URL, { ...init, dispatcher }) as unknown as Response
  );
  return { fetchImpl, close: () => dispatcher.close() };
}

interface QaTerminationController {
  controller: AbortController;
  receivedSignal(): NodeJS.Signals | null;
  exitCode(): 130 | 143;
  dispose(): void;
}

function qaTerminationController(): QaTerminationController {
  const controller = new AbortController();
  let received: NodeJS.Signals | null = null;
  const record = (signal: NodeJS.Signals) => {
    if (received === null) received = signal;
    controller.abort(new Error(`QA interrupted by ${signal}`));
  };
  const onSigint = () => record('SIGINT');
  const onSigterm = () => record('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    controller,
    receivedSignal: () => received,
    exitCode: () => (received === 'SIGTERM' ? 143 : 130),
    dispose: () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}

async function runQaPolicyCommand(args: Args): Promise<number> {
  const termination = qaTerminationController();
  try {
    const code = await runQaPolicyCommandActive(args, termination);
    return termination.receivedSignal() ? termination.exitCode() : code;
  } catch (error) {
    if (termination.receivedSignal()) return termination.exitCode();
    throw error;
  } finally {
    termination.dispose();
  }
}

async function runQaPolicyCommandActive(
  args: Args,
  termination: QaTerminationController,
): Promise<number> {
  const { controller } = termination;
  if (args.pr === null || !Number.isSafeInteger(args.pr) || args.pr < 1) {
    throw new Error('qa-policy requires --pr <positive-number>');
  }
  const repoDir = await repoRoot(args.repoDir, controller.signal);
  const repo = args.repo ?? (await inferRepo(repoDir, controller.signal));
  if (!repo) throw new Error('qa-policy needs a repository: pass --repo owner/name');
  const token = await githubToken(controller.signal);
  if (!token) throw new Error('qa-policy needs GITHUB_TOKEN, GH_TOKEN, or an authenticated GitHub CLI');
  const transport = qaPolicyTransport();
  const { pull, resolved } = await (async () => {
    try {
      const client = new GitHubClient({
        token,
        repo,
        version: VERSION,
        fetchImpl: transport.fetchImpl,
        signal: controller.signal,
      });
      const pull = await client.getPull(args.pr!);
      if (!pull.merged || !pull.mergeCommitSha) throw new Error(`PR #${pull.number} is not merged`);
      assertQaPullRepository(pull, repo);
      const resolved = await resolveMergedPull(client, pull);
      return { pull, resolved };
    } finally {
      await transport.close();
    }
  })();
  const loaded = await loadQaConfigConsensusFromBases(
    repoDir,
    resolved.policyBaseShas,
    args.config,
    {
      force: args.forceQa,
      promisor: githubPromisorAccess(repo, token),
      signal: controller.signal,
    },
  );
  const qaConfig = structuredClone(loaded.config.qa);
  for (const raw of args.allowOrigins) {
    const origin = qaExactOrigin(raw);
    if (!qaConfig.sandbox.allowed_origins.includes(origin)) qaConfig.sandbox.allowed_origins.push(origin);
  }
  if (args.targetUrl) {
    const targetOrigin = new URL(args.targetUrl).origin;
    if (!qaConfig.sandbox.allowed_origins.includes(targetOrigin)) {
      throw new Error(`explicit target origin ${targetOrigin} is not in the trusted QA allowlist`);
    }
  }
  const enabled = qaConfig.enabled || args.forceQa;
  const serviceOrigins = qaServiceOrigins(process.env);
  controller.signal.throwIfAborted();
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    enabled,
    pr_number: pull.number,
    merge_sha: resolved.mergeSha,
    base_resolution: resolved.baseResolution,
    source_base_sha: resolved.sourceBaseSha,
    policy_base_shas: resolved.policyBaseShas,
    allowed_origins: [...new Set([...serviceOrigins, ...qaConfig.sandbox.allowed_origins])],
    retention_days: qaConfig.evidence.retention_days,
  })}\n`);
  return 0;
}

function parsePersistedQaRunResult(raw: unknown): QaRunResult {
  if (!isQaRunResult(raw)) {
    throw new Error('QA report does not match the persisted v1 result shape');
  }
  return raw as QaRunResult;
}

function qaOutputSecretValues(): string[] {
  try {
    return Object.values(decodeQaSecrets(process.env.JUROR_QA_SECRETS_B64));
  } catch {
    // runQa emits a fixed infrastructure result for a malformed bundle. Do not
    // reflect malformed input while rendering that report.
    return [];
  }
}

async function persistFinalQaResult(
  reportPath: string,
  markdownPath: string | null,
  result: QaRunResult,
  options: { jobUrl: string | null; artifactUrl: string | null },
): Promise<string> {
  if (!isQaRunResult(result)) {
    throw new Error('Refusing to persist an invalid finalized QA result');
  }
  const outputSecrets = qaOutputSecretValues();
  const markdown = renderQaSummary(result, { ...options, secrets: outputSecrets });
  const report = serializeQaReport(result, outputSecrets);
  if (containsQaPresentationSecret(markdown, outputSecrets)) {
    throw new Error('Refusing to persist QA Markdown containing a configured secret canary');
  }
  checkedQaOutput(markdown, outputSecrets);
  await writeFile(reportPath, report, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (markdownPath) await writeFile(markdownPath, markdown, 'utf8');
  return markdown;
}

/** Internal Action phase: make artifact delivery part of the semantic QA outcome. */
async function runQaFinalizeCommand(args: Args): Promise<number> {
  if (!args.report) throw new Error('qa-finalize requires --report <path>');
  if (args.pr === null || !Number.isSafeInteger(args.pr) || args.pr < 1) {
    throw new Error('qa-finalize requires --pr <positive-number>');
  }
  if (!args.repo || !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) {
    throw new Error('qa-finalize requires --repo owner/name');
  }
  if (args.post && args.postPending) {
    throw new Error('qa-finalize accepts only one of --post or --post-pending');
  }
  const uploadFailed = Boolean(args.artifactUploadError?.trim());
  const laterFailure = Boolean(args.finalizationError?.trim());
  const hasArtifactName = Boolean(args.artifactName?.trim());
  const hasArtifactUrl = Boolean(args.artifactUrl?.trim());
  if (hasArtifactName !== hasArtifactUrl) {
    throw new Error('qa-finalize requires --artifact-name and --artifact-url together');
  }
  const delivered = hasArtifactName && hasArtifactUrl;
  if (
    (laterFailure && uploadFailed) ||
    (!laterFailure && Number(uploadFailed) + Number(delivered) !== 1)
  ) {
    throw new Error(
      'qa-finalize requires artifact delivery or --artifact-upload-error, with optional delivery metadata for --finalization-error',
    );
  }

  const parsed = JSON.parse(await readFile(args.report, 'utf8')) as unknown;
  const original = parsePersistedQaRunResult(parsed);
  if (original.repository.toLowerCase() !== args.repo.toLowerCase() || original.pr_number !== args.pr) {
    throw new Error('QA report repository or pull request does not match finalizer arguments');
  }

  const deliveredResult = delivered
    ? finalizeQaEvidence(original, { artifactName: args.artifactName, artifactUrl: args.artifactUrl })
    : original;
  let result = laterFailure
    ? markQaInfrastructureError(deliveredResult, args.finalizationError!)
    : finalizeQaEvidence(original, uploadFailed
      ? { error: args.artifactUploadError }
      : { artifactName: args.artifactName, artifactUrl: args.artifactUrl });
  const artifactUrl = laterFailure
    ? args.artifactUrl ?? original.artifacts.find((artifact) => artifact.upload)?.upload?.url ?? null
    : uploadFailed ? null : args.artifactUrl;
  const jobUrl = actionRunUrl(args.repo);
  await persistFinalQaResult(args.report, args.markdown, result, { jobUrl, artifactUrl });

  if (qaPublicationAllowed(args.post || args.postPending, result.outcome === 'cancelled')) {
    const token = await githubToken();
    if (!token) {
      result = markQaInfrastructureError(
        result,
        'QA result publication was requested but no GitHub token was available',
      );
      await persistFinalQaResult(args.report, args.markdown, result, { jobUrl, artifactUrl });
      return 0;
    }
    const client = new GitHubClient({ token, repo: args.repo, version: VERSION });
    try {
      const outputSecrets = qaOutputSecretValues();
      const published = args.postPending
        ? await publishQaPending(client, args.pr, result, { jobUrl, artifactUrl, secrets: outputSecrets })
        : await publishQaResult(client, args.pr, result, { jobUrl, artifactUrl, secrets: outputSecrets });
      log.info(
        `${published.updated ? 'updated' : 'posted'} ${args.postPending ? 'pending ' : ''}QA comment #${published.commentId}`,
      );
    } catch (error) {
      result = markQaInfrastructureError(
        result,
        `QA result publication failed: ${errorMessage(error)}`,
      );
      await persistFinalQaResult(args.report, args.markdown, result, { jobUrl, artifactUrl });
      log.error('QA result publication failed; finalized as an infrastructure error');
      return 0;
    }
  }

  log.info(`finalized QA evidence: ${args.report}`);
  // This internal phase reports command completion, not the semantic QA conclusion. The
  // composite Action reads the persisted report to apply success, failure, or cancellation;
  // any non-zero process exit therefore unambiguously means finalization itself crashed.
  return 0;
}

/** Final best-effort transition from the non-final sticky after immutable result upload. */
async function runQaPublishFinalCommand(args: Args): Promise<number> {
  if (!args.report) throw new Error('qa-publish-final requires --report <path>');
  if (args.pr === null || !Number.isSafeInteger(args.pr) || args.pr < 1) {
    throw new Error('qa-publish-final requires --pr <positive-number>');
  }
  if (!args.repo || !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) {
    throw new Error('qa-publish-final requires --repo owner/name');
  }
  const parsed = JSON.parse(await readFile(args.report, 'utf8')) as unknown;
  const result = parsePersistedQaRunResult(parsed);
  if (result.repository.toLowerCase() !== args.repo.toLowerCase() || result.pr_number !== args.pr) {
    throw new Error('QA report repository or pull request does not match publisher arguments');
  }
  if (result.outcome === 'cancelled') return 0;
  let artifactUrl = result.artifacts.find((artifact) => artifact.upload)?.upload?.url ?? null;
  if (args.artifactUrl?.trim()) {
    try {
      artifactUrl = normalizeQaArtifactUrl(args.artifactUrl);
    } catch (error) {
      throw new Error(`qa-publish-final --artifact-url is invalid: ${errorMessage(error)}`);
    }
  }
  const token = await githubToken();
  if (!token) throw new Error('qa-publish-final requires a GitHub token');
  const client = new GitHubClient({ token, repo: args.repo, version: VERSION });
  const published = await publishQaResult(client, args.pr, result, {
    jobUrl: actionRunUrl(args.repo),
    artifactUrl,
    secrets: qaOutputSecretValues(),
  });
  log.info(`${published.updated ? 'updated' : 'posted'} final QA comment #${published.commentId}`);
  return 0;
}

async function runQaCommand(args: Args): Promise<number> {
  const termination = qaTerminationController();
  try {
    const code = await runQaCommandActive(args, termination);
    return termination.receivedSignal() ? termination.exitCode() : code;
  } catch (error) {
    if (termination.receivedSignal()) return termination.exitCode();
    throw error;
  } finally {
    termination.dispose();
  }
}

async function runQaCommandActive(
  args: Args,
  termination: QaTerminationController,
): Promise<number> {
  const { controller } = termination;
  if (args.pr === null || !Number.isSafeInteger(args.pr) || args.pr < 1) {
    throw new Error('qa requires --pr <positive-number>');
  }
  if (args.targetSha && !/^[0-9a-f]{40}$/i.test(args.targetSha)) {
    throw new Error('--target-sha must be a full 40-character commit SHA');
  }
  if (args.targetSha && !args.targetUrl) {
    throw new Error('--target-sha requires --target-url');
  }
  const repoDir = await repoRoot(args.repoDir, controller.signal);
  // The tested repository is post-merge, untrusted input. In particular, environment variables
  // such as GIT_CONFIG_* can make `git worktree add` execute repository-controlled hooks. QA
  // therefore never auto-loads repoDir/.env and accepts only credential names from an explicit,
  // operator-owned file outside the repository.
  const loaded = loadQaEnvFile(args.envFile, repoDir);
  if (loaded) log.debug(`loaded ${loaded} variable(s) from the env file`);
  const repo = args.repo ?? (await inferRepo(repoDir, controller.signal));
  if (!repo) throw new Error('qa needs a repository: pass --repo owner/name');
  const token = await githubToken(controller.signal);
  if (!token) throw new Error('qa needs GITHUB_TOKEN, GH_TOKEN, or an authenticated GitHub CLI');
  const client = new GitHubClient({ token, repo, version: VERSION, signal: controller.signal });
  const pull = await client.getPull(args.pr);
  if (!pull.merged || !pull.mergeCommitSha) {
    throw new Error(`PR #${pull.number} is not merged; post-merge QA only accepts merged pull requests`);
  }
  assertQaPullRepository(pull, repo);
  log.step(`QA for merged PR #${pull.number} — ${pull.title}`);

  const resolved = await resolveMergedPull(client, pull);
  const qaPull: PullMeta = {
    ...pull,
    baseSha: resolved.sourceBaseSha,
    mergeCommitSha: resolved.mergeSha,
  };
  const loadedConfig = await loadQaConfigConsensusFromBases(
    repoDir,
    resolved.policyBaseShas,
    args.config,
    {
      force: args.forceQa,
      promisor: githubPromisorAccess(repo, token),
      signal: controller.signal,
    },
  );
  for (const problem of loadedConfig.problems) log.warn(`config: ${problem}`);
  const qaConfig = structuredClone(loadedConfig.config.qa);
  for (const raw of args.allowOrigins) {
    const origin = qaExactOrigin(raw);
    if (!qaConfig.sandbox.allowed_origins.includes(origin)) qaConfig.sandbox.allowed_origins.push(origin);
  }
  if (!qaConfig.enabled) {
    if (!args.forceQa) {
      log.info('QA is disabled by trusted configuration; use `juror qa --force` for an explicit local run');
      return 0;
    }
    log.warn('qa.enabled is false; proceeding because --force was supplied');
  }
  let checkout: EphemeralCheckout | null = null;
  try {
    const preparedCheckout = await checkoutAt(repoDir, resolved.mergeSha, {
      prNumber: pull.number,
      promisor: githubPromisorAccess(repo, token),
      requiredCommits: [resolved.sourceBaseSha],
      signal: controller.signal,
    });
    checkout = preparedCheckout;
    const patch = await preparedCheckout.diffFrom(resolved.sourceBaseSha, QA_MAX_DIFF_BYTES);
    const changedFiles = await preparedCheckout.changedPathsFrom(
      resolved.sourceBaseSha,
      QA_MAX_CHANGED_PATH_BYTES,
    );
    if (Buffer.byteLength(JSON.stringify(changedFiles), 'utf8') > QA_MAX_CHANGED_PATH_BYTES) {
      throw new Error(
        `Merged change-path manifest exceeds ${QA_MAX_CHANGED_PATH_BYTES} bytes; ` +
          'refusing to plan from an incomplete affected-file list',
      );
    }
    const conservative = resolved.baseResolution === 'conservative';
    const instructions = conservative
      ? {
          rendered:
            '(Trusted repository QA instructions were omitted because merge topology did not identify one exact pre-merge base.)',
          paths: [],
          problems: [
            'merge topology has multiple plausible policy bases; repository QA instructions were omitted',
          ],
        }
      : await loadAgentInstructions(
          preparedCheckout.dir,
          resolved.sourceBaseSha,
          changedFiles,
          controller.signal,
        );
    for (const problem of instructions.problems) log.warn(`QA instructions: ${problem}`);
    const changeScopeNote = conservative
      ? `Merge topology is ambiguous; QA conservatively tests ${resolved.sourceBaseSha.slice(0, 12)}..${resolved.mergeSha.slice(0, 12)}, which can include changes that predate PR #${pull.number}.`
      : undefined;
    if (changeScopeNote) log.warn(changeScopeNote);
    await preparedCheckout.seal();
    if (controller.signal.aborted) return termination.exitCode();
    const stateDir = await gitStateDir(repoDir, controller.signal);
    const runKey = `${pull.number}-${Date.now()}`;
    const requestedEvidenceDir = args.evidenceDir ?? path.join(stateDir, 'qa', runKey);
    const preparedEvidence = await prepareQaEvidenceDirectory(requestedEvidenceDir, runKey);
    const evidenceDir = preparedEvidence.directory;
    if (preparedEvidence.isolated) {
      log.info(`non-empty evidence directory preserved; using isolated run directory ${evidenceDir}`);
    }
    const result = await runQa({
      client,
      pull: qaPull,
      config: qaConfig,
      diffText: patch,
      baseResolution: resolved.baseResolution,
      sourceBaseSha: resolved.sourceBaseSha,
      policyBaseShas: resolved.policyBaseShas,
      changedFiles,
      ...(changeScopeNote ? { changeScopeNote } : {}),
      sourceDir: preparedCheckout.dir,
      instructions: instructions.rendered,
      evidenceDir,
      env: process.env as Record<string, string | undefined>,
      runId: runKey,
      headless: !args.headed,
      keepScratch: args.keepScratch,
      signal: controller.signal,
      ...(args.targetUrl ? { explicitTargetUrl: args.targetUrl } : {}),
      ...(args.targetSha ? { explicitTargetSha: args.targetSha.toLowerCase() } : {}),
      ...(args.storageState ? { storageStatePath: args.storageState } : {}),
    });
    const jobUrl = actionRunUrl(repo);
    const outputSecrets = qaOutputSecretValues();
    if (!args.json || args.markdown) {
      const markdown = renderQaSummary(result, { jobUrl, secrets: outputSecrets });
      if (!args.json) {
        process.stdout.write(checkedQaOutput(`${markdown}\n`, outputSecrets));
      }
      if (args.markdown) {
        await writeFile(args.markdown, checkedQaOutput(markdown, outputSecrets), 'utf8');
        log.info(`QA summary written to ${args.markdown}`);
      }
    }
    if (args.json) {
      const payload = serializeQaReport(result, outputSecrets);
      if (typeof args.json === 'string') await writeFile(args.json, payload, 'utf8');
      else process.stdout.write(payload);
    }
    if (qaPublicationAllowed(
      args.post,
      Boolean(termination.receivedSignal()) || result.outcome === 'cancelled',
    )) {
      const published = await publishQaResult(client, pull.number, result, {
        jobUrl,
        secrets: outputSecrets,
      });
      log.info(`${published.updated ? 'updated' : 'posted'} QA comment #${published.commentId}`);
    }
    log.info(`QA evidence: ${evidenceDir}`);
    if (termination.receivedSignal() || result.outcome === 'cancelled') return termination.exitCode();
    return result.conclusion === 'failure' ? 1 : 0;
  } catch (error) {
    if (termination.receivedSignal()) return termination.exitCode();
    throw error;
  } finally {
    if (checkout && !args.keepScratch) await checkout.cleanup();
    else if (checkout?.ephemeral) log.info(`QA source worktree kept at ${checkout.dir}`);
  }
}

async function runBenchmarkCommand(args: Args): Promise<number> {
  if (!args.file) throw new Error('benchmark requires --file <corpus.json>');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(args.file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read benchmark corpus ${args.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = evaluateBenchmark(parseBenchmarkCorpus(raw));
  if (args.json !== true) process.stdout.write(renderBenchmark(result));
  if (args.json) {
    const payload = `${JSON.stringify(result, null, 2)}\n`;
    if (typeof args.json === 'string') await writeFile(args.json, payload, 'utf8');
    else process.stdout.write(payload);
  }
  return 0;
}

function safeRecordSpend(stateDir: string, usd: number | null, prKey: string) {
  // GitHub-hosted runners discard their checkout after every job. A ledger stored there
  // would reset on every invocation and make a "30-day" total look authoritative while it
  // contains only the current run. Keep rolling spend for persistent local/self-hosted
  // checkouts and omit it when persistence is not available.
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    return null;
  }
  try {
    return recordSpend(stateDir, usd, prKey);
  } catch {
    try {
      return loadRolling(stateDir);
    } catch {
      return null;
    }
  }
}

function runnableModelLabels(
  config: JurorConfig,
  onlyModels: string[],
  secrets: NodeJS.ProcessEnv,
): string[] {
  const wanted = new Set(onlyModels.map((id) => id.trim()).filter(Boolean));
  return config.models
    .filter((model) => model.enabled && (wanted.size === 0 || wanted.has(model.id)))
    .filter((model) => Boolean(readSecret(secrets, model.secret).value))
    .map((model) => resolveModelRuntime(model).label);
}

function actionRunUrl(repo: string): string | null {
  const runId = process.env.GITHUB_RUN_ID?.trim();
  if (!runId) return null;
  const server = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/+$/, '');
  return `${server}/${repo}/actions/runs/${encodeURIComponent(runId)}`;
}

function errorMessage(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

/** `DiffFile.positionByLine` is a Map, which `JSON.stringify` would silently flatten to `{}`. */
function serializable(r: unknown): unknown {
  return JSON.parse(
    JSON.stringify(r, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v)),
  );
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`${redact(msg)}\n`);
    process.exit(1);
  });
