import { getSandbox } from '@cloudflare/sandbox';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { HostedReviewReportV1 } from '../../src/cloud/types';
import type { QaRunResult } from '../../src/qa/types';
import { finalizeUsage, retainedStorageCostMicroUsd, sandboxCostMicroUsd } from './billing';
import type { Env, HostedWorkflowParams } from './env';
import { appendRunEvent, updateRunPhase } from './events';
import { indexQaFindings, indexReviewFindings } from './indexing';
import { decryptWorkspaceSecret } from './crypto';
import { publishHostedReview } from './github-publish';
import { sanitizeQaReportForRetention } from './report-redaction';
import { qaTargetHosts } from './sandbox-network';
import hostedRunnerSource from '../runner/runner.mjs';

const CODEX_HTTPS_WRAPPER = `#!/usr/bin/env node
import { spawn } from 'node:child_process';

const child = spawn('/usr/local/bin/codex', [
  '-c', 'model_provider="juror_openai_https"',
  '-c', 'model_providers.juror_openai_https.name="OpenAI"',
  '-c', 'model_providers.juror_openai_https.wire_api="responses"',
  '-c', 'model_providers.juror_openai_https.requires_openai_auth=true',
  '-c', 'model_providers.juror_openai_https.supports_websockets=false',
  '-c', 'features.apps=false',
  ...process.argv.slice(2),
], { stdio: 'inherit', env: process.env });
child.once('error', (error) => {
  console.error('could not start the pinned Codex CLI:', error.message);
  process.exit(1);
});
child.once('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;

const CODEWHALE_CA_WRAPPER = `#!/bin/sh
export NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
exec /usr/local/bin/codewhale "$@"
`;

interface HostedQaConfig {
  enabled: boolean;
  target: { strategy: 'staging-first'; environment: 'staging'; static_url: string; preview_fallback: false; wait_seconds: number };
  auth: {
    session_bootstrap: { url: string; secret_ref: string; target_origin: string; ready_storage_key: string } | null;
    browser_secret_headers: Array<{ name: string; secret_ref: string; origins: string[] }>;
    steps: [];
  };
  sandbox: {
    allowed_origins: string[];
    reset: { url: string; method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; secret_headers: Array<{ name: string; secret_ref: string; format: 'bearer' | 'raw' }>; expected_statuses: number[]; timeout_seconds?: number } | null;
  };
  evidence: { screenshot: 'all' | 'failure' | 'off'; trace: 'all' | 'failure' | 'off'; video: 'all' | 'failure' | 'off'; retention_days: number };
}

interface RunManifest {
  runId: string;
  kind: 'review' | 'qa';
  repository: string;
  prNumber: number;
  revisionSha: string;
  preset: string;
  publishMode: 'all' | 'consensus';
  severityFloor: 'P0' | 'P1' | 'P2' | 'P3';
  targetUrl: string | null;
  allowedOrigins: string[];
  qaConfig: HostedQaConfig | null;
  qaSecretRefs: string[];
}

interface RunRow {
  id: string;
  workspace_id: string;
  kind: 'review' | 'qa';
  full_name: string;
  pr_number: number;
  revision_sha: string;
  review_preset: string;
  publish_mode: 'all' | 'consensus';
  severity_floor: 'P0' | 'P1' | 'P2' | 'P3';
  qa_target_url: string | null;
  qa_allowed_origins_json: string;
  qa_session_bootstrap_json: string | null;
  qa_session_bootstrap_ciphertext: string | null;
  qa_secret_headers_ciphertext: string | null;
  qa_reset_hook_ciphertext: string | null;
  qa_evidence_policy_json: string;
}

async function loadManifest(env: Env, runId: string): Promise<RunManifest> {
  const row = await env.DB.prepare(`SELECT r.id, r.workspace_id, r.kind, repo.full_name, r.pr_number, r.revision_sha, rs.review_preset, rs.publish_mode, rs.severity_floor, rs.qa_target_url, rs.qa_allowed_origins_json, rs.qa_session_bootstrap_json, rs.qa_session_bootstrap_ciphertext, rs.qa_secret_headers_ciphertext, rs.qa_reset_hook_ciphertext, rs.qa_evidence_policy_json FROM run r JOIN repository repo ON repo.id = r.repository_id JOIN repository_settings rs ON rs.repository_id = repo.id WHERE r.id = ?`)
    .bind(runId).first<RunRow>();
  if (!row) throw new Error('Run does not exist');
  const allowedOrigins = JSON.parse(row.qa_allowed_origins_json) as string[];
  let qaConfig: HostedQaConfig | null = null;
  const qaSecretRefs: string[] = [];
  if (row.kind === 'qa') {
    if (!row.qa_target_url) throw new Error('QA target is not configured');
    const browserHeaders = row.qa_secret_headers_ciphertext
      ? JSON.parse(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_secret_headers_ciphertext)) as Array<{ name: string; origins: string[] }>
      : [];
    const safeBrowserHeaders = browserHeaders.map((header, index) => {
      const secretRef = `JUROR_HOSTED_HEADER_${index}`; qaSecretRefs.push(secretRef);
      return { name: header.name, secret_ref: secretRef, origins: header.origins.map((origin) => new URL(origin).origin) };
    });
    const bootstrap = row.qa_session_bootstrap_json ? JSON.parse(row.qa_session_bootstrap_json) as HostedQaConfig['auth']['session_bootstrap'] : null;
    if (bootstrap) qaSecretRefs.push('JUROR_HOSTED_SESSION');
    const reset = row.qa_reset_hook_ciphertext
      ? JSON.parse(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_reset_hook_ciphertext)) as { url: string; method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; secretHeaders: Array<{ name: string; format: 'bearer' | 'raw' }>; expectedStatuses: number[]; timeoutSeconds?: number }
      : null;
    const safeReset = reset ? {
      url: reset.url,
      method: reset.method,
      secret_headers: reset.secretHeaders.map((header, index) => { const secretRef = `JUROR_HOSTED_RESET_${index}`; qaSecretRefs.push(secretRef); return { name: header.name, secret_ref: secretRef, format: header.format }; }),
      expected_statuses: reset.expectedStatuses,
      ...(reset.timeoutSeconds ? { timeout_seconds: reset.timeoutSeconds } : {}),
    } : null;
    const evidence = JSON.parse(row.qa_evidence_policy_json) as Partial<HostedQaConfig['evidence']>;
    qaConfig = {
      enabled: true,
      target: { strategy: 'staging-first', environment: 'staging', static_url: row.qa_target_url, preview_fallback: false, wait_seconds: 900 },
      auth: { session_bootstrap: bootstrap, browser_secret_headers: safeBrowserHeaders, steps: [] },
      sandbox: { allowed_origins: allowedOrigins, reset: safeReset },
      evidence: { screenshot: evidence.screenshot ?? 'failure', trace: evidence.trace ?? 'failure', video: evidence.video ?? 'failure', retention_days: 14 },
    };
  }
  return { runId: row.id, kind: row.kind, repository: row.full_name, prNumber: row.pr_number, revisionSha: row.revision_sha, preset: row.review_preset, publishMode: row.publish_mode, severityFloor: row.severity_floor, targetUrl: row.qa_target_url, allowedOrigins, qaConfig, qaSecretRefs };
}

export async function startNextRepositoryQa(env: Env, completedRunId: string): Promise<boolean> {
  const next = await env.DB.prepare(`SELECT queued.id FROM run current JOIN run queued ON queued.repository_id = current.repository_id JOIN repository_settings settings ON settings.repository_id = queued.repository_id JOIN repository ON repository.id = queued.repository_id WHERE current.id = ? AND repository.github_access_state = 'active' AND settings.qa_enabled = 1 AND settings.qa_security_ready = 1 AND queued.kind = 'qa' AND queued.status = 'queued' AND queued.workflow_instance_id IS NULL AND NOT EXISTS (SELECT 1 FROM run active WHERE active.repository_id = queued.repository_id AND active.kind = 'qa' AND active.id != queued.id AND active.status IN ('queued', 'running') AND active.workflow_instance_id IS NOT NULL) ORDER BY queued.created_at, queued.id LIMIT 1`)
    .bind(completedRunId).first<{ id: string }>();
  if (!next) return false;
  const claim = await env.DB.prepare(`UPDATE run SET workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND workflow_instance_id IS NULL AND EXISTS (SELECT 1 FROM repository admission_repository WHERE admission_repository.id = (SELECT repository_id FROM run WHERE id = ?) AND admission_repository.github_access_state = 'active') AND NOT EXISTS (SELECT 1 FROM run active WHERE active.repository_id = (SELECT repository_id FROM run WHERE id = ?) AND active.kind = 'qa' AND active.id != ? AND active.status IN ('queued', 'running') AND active.workflow_instance_id IS NOT NULL)`)
    .bind(next.id, new Date().toISOString(), next.id, next.id, next.id, next.id).run();
  if (!claim.meta.changes) return false;
  let workflowId = next.id;
  try {
    const handle = await env.QA_WORKFLOW.create({ id: next.id, params: { runId: next.id }, retention: { successRetention: '30 days', errorRetention: '30 days' } });
    workflowId = handle.id;
  } catch (error) {
    await env.DB.prepare(`UPDATE run SET workflow_instance_id = NULL, updated_at = ? WHERE id = ? AND workflow_instance_id = ?`).bind(new Date().toISOString(), next.id, next.id).run();
    throw error;
  }
  try {
    const cancelled = await env.DB.prepare(`SELECT 1 AS cancelled FROM run WHERE id = ? AND status = 'cancelled'`).bind(next.id).first();
    if (cancelled) await (await env.QA_WORKFLOW.get(workflowId)).terminate();
  } catch { /* The Workflow itself also refuses a cancelled row before Sandbox admission. */ }
  return true;
}

export async function enqueueNextRepositoryQa(env: Env, anchorRunId: string): Promise<void> {
  await env.WEBHOOK_QUEUE.send({ kind: 'qa_admission', anchorRunId }, { contentType: 'json' });
}

export async function sweepQueuedQaAdmissions(env: Env): Promise<number> {
  const candidates = await env.DB.prepare(`SELECT queued.id FROM run queued JOIN repository_settings settings ON settings.repository_id = queued.repository_id JOIN repository ON repository.id = queued.repository_id WHERE repository.github_access_state = 'active' AND settings.qa_enabled = 1 AND settings.qa_security_ready = 1 AND queued.kind = 'qa' AND queued.status = 'queued' AND queued.workflow_instance_id IS NULL AND NOT EXISTS (SELECT 1 FROM run active WHERE active.repository_id = queued.repository_id AND active.kind = 'qa' AND active.id != queued.id AND active.status IN ('queued', 'running') AND active.workflow_instance_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM run earlier WHERE earlier.repository_id = queued.repository_id AND earlier.kind = 'qa' AND earlier.status = 'queued' AND earlier.workflow_instance_id IS NULL AND (earlier.created_at < queued.created_at OR (earlier.created_at = queued.created_at AND earlier.id < queued.id))) ORDER BY queued.created_at, queued.id LIMIT 50`)
    .all<{ id: string }>();
  for (const candidate of candidates.results) await enqueueNextRepositoryQa(env, candidate.id);
  return candidates.results.length;
}

const EVIDENCE_ROOT = '/tmp/juror-evidence/';
const MAX_EVIDENCE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 300 * 1024 * 1024;

/**
 * Workflow termination can interrupt a running step before its `finally` block
 * reaches the Sandbox. Call this from every external cancellation path so a
 * cancelled run cannot retain a heartbeat-enabled container.
 */
export async function destroyRunSandbox(env: Env, kind: 'review' | 'qa', runId: string): Promise<void> {
  const namespace = kind === 'review' ? env.ReviewSandbox : env.QaSandbox;
  try {
    await getSandbox(namespace, runId.toLowerCase(), { normalizeId: true }).destroy();
  } catch (error) {
    console.warn(JSON.stringify({ event: 'sandbox_cleanup_failed', runId, kind, error: error instanceof Error ? error.message : String(error) }));
  }
}

function safeEvidenceContentType(kind: string, mimeType?: string): string {
  if (kind === 'screenshot') return 'image/png';
  if (kind === 'video') return 'video/webm';
  if (kind === 'trace') return 'application/zip';
  if (mimeType && /^(image\/png|video\/webm|application\/zip|application\/json|text\/plain)$/.test(mimeType)) return mimeType;
  return 'application/octet-stream';
}

function base64Bytes(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function executeInSandbox(env: Env, manifest: RunManifest): Promise<{ reportJson: string; durationMs: number; cpuTimeMs: number; evidenceBytes: number; reviewerDiagnostics: string[] }> {
  const namespace = manifest.kind === 'review' ? env.ReviewSandbox : env.QaSandbox;
  // A review can run for up to 30 minutes. A finite inactivity timeout protects
  // against a Worker or Workflow termination that prevents the finalizer below
  // from running, unlike keepAlive which persists indefinitely.
  const sandbox = getSandbox(namespace, manifest.runId.toLowerCase(), { normalizeId: true, sleepAfter: '40m' });
  const started = Date.now();
  try {
    const targetHosts = qaTargetHosts(manifest.kind, manifest.allowedOrigins);
    const baseHosts = ['github.com', 'api.github.com', 'api.openai.com', 'api.anthropic.com', 'api.x.ai', 'api.deepseek.com', 'api.fireworks.ai', 'openrouter.ai', 'api.scaleway.ai', 'api.moonshot.ai'];
    await sandbox.setAllowedHosts([...new Set([...baseHosts, ...targetHosts])]);
    await sandbox.setOutboundByHosts<RunManifest>({
      'github.com': { method: 'authenticatedGithub', params: manifest },
      'api.github.com': { method: 'authenticatedGithub', params: manifest },
      'api.openai.com': 'authenticatedProvider',
      'api.anthropic.com': 'authenticatedProvider',
      'api.x.ai': 'authenticatedProvider',
      'api.deepseek.com': 'authenticatedProvider',
      'api.fireworks.ai': 'authenticatedProvider',
      'openrouter.ai': 'authenticatedProvider',
      'api.scaleway.ai': 'authenticatedProvider',
      'api.moonshot.ai': 'authenticatedProvider',
      ...Object.fromEntries(targetHosts.map((host) => [host, { method: 'qaTarget', params: manifest }])),
    });
    // Production pins immutable Sandbox images. Overlay the small trusted controller
    // artifacts on every run so Worker and runner releases cannot drift while a new image
    // rolls out. The wrapper also forces older bundled Juror builds onto HTTPS Responses.
    const prepare = await sandbox.exec('mkdir -p /tmp/juror-bin && chmod 0700 /tmp/juror-bin');
    if (!prepare.success) throw new Error('Hosted runtime overlay directory could not be prepared');
    await sandbox.writeFile('/opt/juror/cloud/runner-live.mjs', hostedRunnerSource);
    await sandbox.writeFile('/tmp/juror-bin/codex', CODEX_HTTPS_WRAPPER);
    await sandbox.writeFile('/tmp/juror-bin/codewhale', CODEWHALE_CA_WRAPPER);
    const seal = await sandbox.exec('chmod 0555 /opt/juror/cloud/runner-live.mjs /tmp/juror-bin/codex /tmp/juror-bin/codewhale');
    if (!seal.success) throw new Error('Hosted runtime overlay could not be sealed');
    await sandbox.writeFile('/tmp/juror-run.json', JSON.stringify(manifest));
    const result = await sandbox.exec(`/usr/bin/time -f '{"userSeconds":%U,"systemSeconds":%S}' -o /tmp/juror-resource.json node /opt/juror/cloud/runner-live.mjs /tmp/juror-run.json /tmp/juror-report.json`, {
      timeout: manifest.kind === 'review' ? 30 * 60 * 1000 : 20 * 60 * 1000,
      env: {
        PATH: '/tmp/juror-bin:/usr/local/bin:/usr/bin:/bin',
        NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
        GITHUB_TOKEN: 'injected-by-juror-outbound-handler',
        JUROR_OPENAI_API_KEY: 'injected-by-juror-outbound-handler',
        JUROR_ANTHROPIC_API_KEY: 'injected-by-juror-outbound-handler',
        JUROR_XAI_API_KEY: 'injected-by-juror-outbound-handler',
        JUROR_FIREWORKS_API_KEY: 'injected-by-juror-outbound-handler',
        JUROR_OPENROUTER_API_KEY: 'injected-by-juror-outbound-handler',
        JUROR_SCALEWAY_API_KEY: 'injected-by-juror-outbound-handler',
        JUROR_QA_SECRETS_B64: btoa(JSON.stringify(Object.fromEntries(manifest.qaSecretRefs.map((reference) => [reference, `hosted-outbound-placeholder-${reference}`])))),
      },
    });
    if (!result.success) {
      const diagnostic = result.stderr
        .replace(/(?:sk|fw|gh[opsu])-[-A-Za-z0-9_]{12,}/g, '[redacted]')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(-500);
      throw new Error(`Hosted runner exited ${result.exitCode}${diagnostic ? `: ${diagnostic}` : ''}`);
    }
    const reviewerDiagnostics = result.stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[juror-model] '))
      .map((line) => line.replace(/(?:sk|fw|gh[opsu])-[-A-Za-z0-9_]{12,}/g, '[redacted]').slice(0, 600));
    for (const diagnostic of reviewerDiagnostics) console.warn(diagnostic);
    const resourceFile = await sandbox.readFile('/tmp/juror-resource.json', { encoding: 'utf8' });
    if (!resourceFile.success) throw new Error('Container usage receipt could not be read');
    const resource = JSON.parse(resourceFile.content) as { userSeconds?: number; systemSeconds?: number };
    const cpuSeconds = Number(resource.userSeconds) + Number(resource.systemSeconds);
    if (!Number.isFinite(cpuSeconds) || cpuSeconds < 0) throw new Error('Container usage receipt is invalid');
    const reportFile = await sandbox.readFile('/tmp/juror-report.json', { encoding: 'utf8' });
    if (!reportFile.success) throw new Error('Hosted report could not be read');
    let reportJson = reportFile.content;
    let evidenceBytes = 0;
    if (manifest.kind === 'qa') {
      reportJson = await sanitizeQaReportForRetention(env, manifest.runId, reportJson);
      const report = JSON.parse(reportJson) as QaRunResult;
      for (const artifact of report.artifacts.slice(0, 50)) {
        if (!artifact.sanitized || artifact.kind === 'report') {
          artifact.path = '';
          artifact.upload = null;
          continue;
        }
        const normalizedPath = artifact.path.replaceAll('\\', '/');
        if (!normalizedPath.startsWith(EVIDENCE_ROOT) || normalizedPath.includes('/../')) throw new Error('QA artifact escaped the evidence directory');
        const evidenceFile = await sandbox.readFile(normalizedPath, { encoding: 'base64' });
        if (!evidenceFile.success || (evidenceFile.size ?? 0) > MAX_EVIDENCE_FILE_BYTES) throw new Error('QA artifact is missing or exceeds the retention limit');
        const bytes = base64Bytes(evidenceFile.content);
        evidenceBytes += bytes.byteLength;
        if (evidenceBytes > MAX_EVIDENCE_TOTAL_BYTES) throw new Error('QA evidence exceeds the per-run retention limit');
        const digest = await sha256Hex(bytes);
        if (digest !== artifact.sha256.toLowerCase()) throw new Error('QA artifact hash does not match its sealed report');
        const artifactId = `artifact_${manifest.runId}_${artifact.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const key = `evidence/${manifest.runId}/${artifactId}`;
        const contentType = safeEvidenceContentType(artifact.kind, evidenceFile.mimeType);
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
        await env.REPORTS.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { runId: manifest.runId, artifactId, sanitized: 'true' } });
        await env.DB.prepare(`INSERT INTO artifact_metadata (id, run_id, kind, r2_key, content_type, size_bytes, sha256, sanitized, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, sanitized = 1, expires_at = excluded.expires_at`)
          .bind(artifactId, manifest.runId, artifact.kind, key, contentType, bytes.byteLength, digest, createdAt, expiresAt).run();
        artifact.path = '';
        artifact.retention_days = 90;
        artifact.upload = { name: artifactId, url: `/api/artifacts/${artifactId}/url` };
      }
      report.artifacts = report.artifacts.slice(0, 50);
      reportJson = JSON.stringify(report);
    }
    return { reviewerDiagnostics, reportJson, durationMs: Date.now() - started, cpuTimeMs: Math.round(cpuSeconds * 1000), evidenceBytes };
  } finally {
    await sandbox.destroy();
  }
}

abstract class HostedWorkflowBase extends WorkflowEntrypoint<Env, HostedWorkflowParams> {
  abstract kind: 'review' | 'qa';

  async run(event: Readonly<WorkflowEvent<HostedWorkflowParams>>, step: WorkflowStep): Promise<void> {
    const runId = event.payload.runId;
    let publicationFailed = false;
    try {
      const manifest = await step.do('load safe run manifest', () => loadManifest(this.env, runId));
      if (manifest.kind !== this.kind) throw new Error('Workflow kind mismatch');
      const admission = await step.do('mark run started', async () => {
        return { started: await updateRunPhase(this.env, runId, 'preparing', 'running', 'Starting an isolated runtime.') };
      });
      if (!admission.started) return;
      const execution = await step.do('execute isolated juror run', { retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' }, timeout: this.kind === 'review' ? '35 minutes' : '25 minutes' }, async () => {
        const admitted = await updateRunPhase(this.env, runId, this.kind === 'review' ? 'reviewing' : 'running_qa', 'running', this.kind === 'review' ? 'Independent reviewers are inspecting the pull request.' : 'Running two deterministic browser attempts.');
        if (!admitted) throw new Error('Run was cancelled before Sandbox execution');
        return executeInSandbox(this.env, manifest);
      });
      const cancelled = await step.do('honor cancellation before retention', async () => Boolean(await this.env.DB.prepare(`SELECT 1 AS cancelled FROM run WHERE id = ? AND status = 'cancelled'`).bind(runId).first()));
      if (cancelled) {
        if (this.kind === 'qa') try {
          await step.do('queue next QA after cancellation', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } }, () => enqueueNextRepositoryQa(this.env, runId));
        } catch { /* The five-minute admission sweep is the final recovery path. */ }
        return;
      }
      await step.do('sanitize, retain, and index report', async () => {
        const key = `reports/${manifest.runId}/${this.kind}.v1.json`;
        await this.env.REPORTS.put(key, execution.reportJson, { httpMetadata: { contentType: 'application/json' }, customMetadata: { schema: `${this.kind}.v1`, runId } });
        const now = new Date().toISOString();
        await this.env.DB.prepare('UPDATE run SET report_r2_key = ?, updated_at = ? WHERE id = ?').bind(key, now, runId).run();
        const count = this.kind === 'review'
          ? await indexReviewFindings(this.env, runId, JSON.parse(execution.reportJson) as HostedReviewReportV1)
          : await indexQaFindings(this.env, runId, JSON.parse(execution.reportJson) as QaRunResult);
        await appendRunEvent(this.env, runId, 'retaining_evidence', 'succeeded', `Sanitized report retained with ${count} finding${count === 1 ? '' : 's'}.`, { findings: count });
        return { key, count, bytes: new TextEncoder().encode(execution.reportJson).byteLength };
      });
      if (this.kind === 'review') {
        try {
          await step.do('publish sanitized GitHub review', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } }, async () => {
            return publishHostedReview(this.env, runId, JSON.parse(execution.reportJson) as HostedReviewReportV1);
          });
        } catch {
          publicationFailed = true;
          await appendRunEvent(this.env, runId, 'publishing', 'warning', 'The review is available in Juror Cloud, but GitHub publication failed.');
        }
      }
      const settlement = await step.do('finalize usage ledger', async () => {
        const parsed = JSON.parse(execution.reportJson) as HostedReviewReportV1 | QaRunResult;
        const providerUsd = this.kind === 'review' ? (parsed as HostedReviewReportV1).totals.usd : (parsed as QaRunResult).cost.usd;
        const reviewUsable = this.kind === 'review' && (parsed as HostedReviewReportV1).models.some((model) => model.ok && model.report);
        const outcome = this.kind === 'review' ? (reviewUsable ? 'completed' : 'no_usable_model_result') : (parsed as QaRunResult).outcome;
        const reportBytes = new TextEncoder().encode(execution.reportJson).byteLength;
        return finalizeUsage(this.env, { runId, kind: this.kind, outcome, providerMicroUsd: Math.round((providerUsd ?? 0) * 1_000_000), sandboxMicroUsd: sandboxCostMicroUsd(this.env, this.kind, execution.durationMs, execution.cpuTimeMs), storageMicroUsd: retainedStorageCostMicroUsd(this.env, reportBytes, execution.evidenceBytes) });
      });
      await step.do('complete run', async () => {
        const now = new Date().toISOString();
        const started = await this.env.DB.prepare('SELECT started_at FROM run WHERE id = ?').bind(runId).first<{ started_at: string | null }>();
        const duration = started?.started_at ? Date.now() - new Date(started.started_at).getTime() : execution.durationMs;
        const outcome = settlement.outcome;
        const status = outcome === 'infrastructure_error' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : publicationFailed ? 'warning' : outcome === 'passed' || outcome === 'no_testable_surface' || outcome === 'completed' ? 'succeeded' : 'warning';
        const phase = status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed';
        const update = await this.env.DB.prepare(`UPDATE run SET status = ?, phase = ?, outcome = ?, reserved_micro_usd = 0, completed_at = ?, duration_ms = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'`).bind(status, phase, outcome, now, duration, now, runId).run();
        if (update.meta.changes) await appendRunEvent(this.env, runId, phase, status === 'warning' ? 'warning' : status, settlement.reservationExceeded ? 'Actual operator cost exceeded the admitted maximum; the run was not billed.' : publicationFailed ? 'Run completed, but GitHub publication needs attention.' : status === 'succeeded' ? 'Run completed.' : `Run completed with outcome: ${outcome}.`, { durationMs: duration });
        return { completed: Boolean(update.meta.changes) };
      });
      if (this.kind === 'qa') try {
        await step.do('queue next repository QA', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } }, () => enqueueNextRepositoryQa(this.env, runId));
      } catch {
        await appendRunEvent(this.env, runId, 'completed', 'warning', 'The next queued QA run will be recovered by the admission sweep.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown infrastructure error';
      const now = new Date().toISOString();
      const cancelled = await this.env.DB.prepare(`SELECT 1 AS cancelled FROM run WHERE id = ? AND status = 'cancelled'`).bind(runId).first();
      if (cancelled) { if (this.kind === 'qa') try { await enqueueNextRepositoryQa(this.env, runId); } catch { /* The admission sweep remains available. */ } return; }
      await this.env.DB.prepare(`UPDATE run SET status = 'failed', phase = 'failed', outcome = 'infrastructure_error', reserved_micro_usd = 0, completed_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, runId).run();
      await appendRunEvent(this.env, runId, 'failed', 'failed', `Juror infrastructure error: ${message}`);
      if (this.kind === 'qa') try { await enqueueNextRepositoryQa(this.env, runId); } catch { /* The admission sweep remains available. */ }
      throw error;
    }
  }
}

export class HostedReviewWorkflow extends HostedWorkflowBase { kind = 'review' as const; }
export class HostedQaWorkflow extends HostedWorkflowBase { kind = 'qa' as const; }
