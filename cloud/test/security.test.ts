import { describe, expect, it } from 'vitest';
import { hmacHex, timingSafeEqual, verifyHmacHeader } from '../worker/crypto';
import { verifyStripeSignature } from '../worker/stripe';
import { requireAdmin } from '../worker/auth';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { unsafeQaOrigin } from '../worker/qa-security';
import { sandboxCodeWhaleReleaseRequestAllowed, sandboxGithubRequestAllowed } from '../worker/github-egress';
import { renderHostedSummary } from '../worker/github-publish';
import type { HostedReviewReportV1 } from '../../src/cloud/types';
import { redactSensitiveJson } from '../worker/report-redaction';
import { qaTargetHosts } from '../worker/sandbox-network';

describe('webhook security boundaries', () => {
  it('accepts only the matching GitHub HMAC', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = await hmacHex('webhook-secret', body);
    await expect(verifyHmacHeader('webhook-secret', body, `sha256=${signature}`)).resolves.toBe(true);
    await expect(verifyHmacHeader('webhook-secret', `${body}x`, `sha256=${signature}`)).resolves.toBe(false);
    await expect(verifyHmacHeader('webhook-secret', body, null)).resolves.toBe(false);
  });

  it('enforces Stripe timestamp tolerance and signature', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex('stripe-secret', `${timestamp}.${body}`);
    await expect(verifyStripeSignature('stripe-secret', body, `t=${timestamp},v1=${signature}`)).resolves.toBe(true);
    await expect(verifyStripeSignature('stripe-secret', body, `t=${timestamp},v1=${signature},v1=${'0'.repeat(64)}`)).resolves.toBe(true);
    await expect(verifyStripeSignature('stripe-secret', body, `t=${timestamp - 601},v1=${signature}`)).resolves.toBe(false);
  });

  it('uses a length-independent comparison and enforces admin-only mutations', () => {
    expect(timingSafeEqual('same', 'same')).toBe(true);
    expect(timingSafeEqual('same', 'different')).toBe(false);
    expect(() => requireAdmin({ userId: 'u', workspaceId: 'w', role: 'admin' })).not.toThrow();
    expect(() => requireAdmin({ userId: 'u', workspaceId: 'w', role: 'member' })).toThrow(HTTPException);
  });

  it('keeps live credentials in outbound handlers and always destroys the sandbox', async () => {
    const sandbox = await readFile(new URL('../worker/sandbox.ts', import.meta.url), 'utf8');
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    const runner = await readFile(new URL('../runner/runner.mjs', import.meta.url), 'utf8');
    expect(sandbox).toContain('enableInternet = false');
    expect(sandbox).toContain("next.headers.set('authorization'");
    expect(sandbox).toContain("redirect: 'manual'");
    expect(sandbox).toContain('ReviewSandbox.outboundHandlers = jurorOutboundHandlers');
    expect(sandbox).toContain('QaSandbox.outboundHandlers = jurorOutboundHandlers');
    expect(sandbox).toContain("hostname === 'api.scaleway.ai' ? env.SCW_SECRET_KEY");
    expect(workflows).toContain("'api.scaleway.ai': 'authenticatedProvider'");
    expect(workflows).toContain("JUROR_SCALEWAY_API_KEY: 'injected-by-juror-outbound-handler'");
    expect(workflows).toContain("GITHUB_TOKEN: 'injected-by-juror-outbound-handler'");
    expect(workflows).toContain("NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt'");
    expect(workflows).toContain("model_providers.juror_openai_https.supports_websockets=false");
    expect(workflows).toContain("node /opt/juror/cloud/runner-live.mjs");
    expect(workflows).toContain("exec /usr/local/bin/codewhale");
    expect(workflows).toContain("replace(/(?:sk|fw|gh[opsu])-");
    expect(workflows).toContain("PATH: '/tmp/juror-bin:/usr/local/bin:/usr/bin:/bin'");
    expect(workflows).toContain('reviewerDiagnostics: string[]');
    expect(workflows).toContain("sleepAfter: '40m'");
    expect(workflows).not.toContain('keepAlive: true');
    expect(workflows).toMatch(/finally\s*{\s*await sandbox\.destroy\(\)/);
    expect(runner).toContain('x-access-token:${githubPlaceholder}@github.com');
    expect(runner).toContain('child.stdout.resume()');
    expect(runner).toContain('Array.isArray(raw.runs)');
    expect(runner).toContain('model?.result?.diagnostics');
    expect(runner).toContain("process.stderr.write(`[juror-model]");
    expect(runner).not.toContain("'--post'");
    expect(runner).not.toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('never routes credential-bearing QA targets into review sandboxes', () => {
    const origins = ['https://staging.example.com', 'https://staging.example.com:443', 'https://api.example.com'];
    expect(qaTargetHosts('review', origins)).toEqual([]);
    expect(qaTargetHosts('qa', origins)).toEqual(['staging.example.com', 'api.example.com']);
  });

  it('limits Sandbox GitHub access to repository reads and git upload-pack', () => {
    const params = { runId: 'run_1', repository: 'Juror-AI/juror', prNumber: 74, revisionSha: 'a'.repeat(40), kind: 'review' as const };
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/Juror-AI/juror/pulls/74'), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/Juror-AI/juror/issues/74/comments?per_page=100&page=1'), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request(`https://api.github.com/repos/Juror-AI/juror/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request('https://github.com/Juror-AI/juror.git/info/refs?service=git-upload-pack'), params)).toBe(true);
    expect(sandboxGithubRequestAllowed(new Request('https://github.com/Juror-AI/juror.git/git-upload-pack', { method: 'POST' }), params)).toBe(true);
    expect(sandboxCodeWhaleReleaseRequestAllowed(new Request('https://github.com/Hmbown/CodeWhale/releases/download/v0.9.7/codewhale-artifacts-sha256.txt'))).toBe(true);
    expect(sandboxCodeWhaleReleaseRequestAllowed(new Request('https://github.com/Hmbown/CodeWhale/releases/download/v0.9.7/codewhale-linux-x64'))).toBe(true);
    expect(sandboxCodeWhaleReleaseRequestAllowed(new Request('https://github.com/Hmbown/CodeWhale/releases/download/v0.9.8/codewhale-linux-x64'))).toBe(false);
    expect(sandboxCodeWhaleReleaseRequestAllowed(new Request('https://github.com/Hmbown/CodeWhale/releases/download/v0.9.7/other'))).toBe(false);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/Juror-AI/juror/issues/74/comments', { method: 'POST' }), params)).toBe(false);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/Juror-AI/juror/issues/74/comments?page=1'), params)).toBe(false);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/repos/other/repo/pulls/74'), params)).toBe(false);
    expect(sandboxGithubRequestAllowed(new Request('https://api.github.com/user'), params)).toBe(false);
  });

  it('defangs untrusted model text before trusted Worker publication', () => {
    const secret = `sk-proj-${'a'.repeat(40)}`;
    const report = {
      models: [{ skipped: false }],
      clusters: [],
      publishedFingerprints: [],
      summary: { summary: `<!-- juror-cloud:summary:v1 --> ping @octocat ${secret}` },
      verdict: { score: 4, confirmed: { P0: 0, P1: 0, P2: 0, P3: 0 } },
      totals: { usd: 1.25 },
    } as unknown as HostedReviewReportV1;
    const rendered = renderHostedSummary(report, 'https://cloud.example/runs/run_1');
    expect(rendered.match(/<!-- juror-cloud:summary:v1 -->/g)).toHaveLength(1);
    expect(rendered).toContain('&lt;!-- juror-cloud:summary:v1 -->');
    expect(rendered).toContain('@\u200boctocat');
    expect(rendered).not.toContain(secret);
  });

  it('redacts raw and encoded QA credentials from reflected semantic output', () => {
    const secret = 'qa secret/value+123';
    const reflected = { actual: `token=${secret}`, nested: [`encoded=${encodeURIComponent(secret)}`, `base64=${btoa(secret)}`] };
    const redacted = JSON.stringify(redactSensitiveJson(reflected, [secret]));
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(encodeURIComponent(secret));
    expect(redacted).not.toContain(btoa(secret));
    expect(redacted).toContain('[redacted]');
  });

  it('redacts QA reports before any retained report or evidence write', async () => {
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    const redaction = workflows.indexOf('reportJson = await sanitizeQaReportForRetention');
    const retention = workflows.indexOf('await env.REPORTS.put');
    expect(redaction).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(redaction);
  });

  it('recovers serialized QA admission through a durable queue and scheduled sweep', async () => {
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    const queue = await readFile(new URL('../worker/queue.ts', import.meta.url), 'utf8');
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(workflows).toContain("kind: 'qa_admission'");
    expect(workflows).toContain('sweepQueuedQaAdmissions');
    expect(queue).toContain("message.kind === 'qa_admission'");
    expect(wrangler).toContain('*/5 * * * *');
  });

  it('keeps the hosted product cloud-only', async () => {
    const pages = await readFile(new URL('../src/pages.tsx', import.meta.url), 'utf8');
    const onboarding = await readFile(new URL('../src/lib/onboarding.ts', import.meta.url), 'utf8');
    const api = await readFile(new URL('../shared/api.ts', import.meta.url), 'utf8');
    const worker = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');
    const reviewService = await readFile(new URL('../worker/review-service.ts', import.meta.url), 'utf8');
    const webhook = await readFile(new URL('../worker/github-webhook.ts', import.meta.url), 'utf8');
    expect(pages).not.toContain('executionMode');
    expect(pages).not.toContain('mode-options');
    expect(pages).not.toContain('Use Action');
    expect(onboarding).not.toContain('executionMode');
    expect(api).not.toContain('executionMode');
    expect(worker).not.toContain('confirmActionDisabled');
    expect(worker).not.toContain('action_conflict');
    expect(worker).toContain('workflowDetection !== false');
    expect(webhook).toContain('upsertRepository(env, installationId, payload.repository, true, false, workflowRefs)');
    expect(webhook).toContain('payload.pull_request.base.sha, payload.pull_request.head.sha');
    expect(reviewService).toContain('[pr.base.sha, pr.head.sha]');
    expect(webhook).toContain("if (workflowDetection === null) throw new Error('GitHub workflow verification is temporarily unavailable')");
    expect(webhook).not.toContain('execution_mode = CASE');
    expect(webhook).toContain('review_enabled = CASE WHEN excluded.action_detected = 1 THEN 0');
  });

  it('claims the per-repository QA slot atomically in every admission path', async () => {
    const webhook = await readFile(new URL('../worker/github-webhook.ts', import.meta.url), 'utf8');
    const workflows = await readFile(new URL('../worker/workflows.ts', import.meta.url), 'utf8');
    expect(webhook).toMatch(/INSERT OR IGNORE INTO run[\s\S]+EXISTS \(SELECT 1 FROM repository admission_repository[\s\S]+admission_repository\.github_access_state = 'active'/);
    expect(webhook).toContain("FROM repository provider_repository WHERE provider_repository.id = ? AND provider_repository.workspace_id = ? AND provider_repository.github_access_state = 'active'");
    expect(webhook).toContain("FROM repository blocked_repository WHERE blocked_repository.id = ? AND blocked_repository.workspace_id = ? AND blocked_repository.github_access_state = 'active'");
    expect(webhook).toMatch(/UPDATE run SET workflow_instance_id[\s\S]+NOT EXISTS \(SELECT 1 FROM run active[\s\S]+active\.repository_id = \?/);
    expect(webhook).toMatch(/UPDATE run SET workflow_instance_id[\s\S]+EXISTS \(SELECT 1 FROM repository admission_repository[\s\S]+admission_repository\.github_access_state = 'active'/);
    expect(workflows).toMatch(/UPDATE run SET workflow_instance_id[\s\S]+NOT EXISTS \(SELECT 1 FROM run active[\s\S]+active\.repository_id = \(SELECT repository_id FROM run WHERE id = \?\)/);
    expect(workflows).toMatch(/UPDATE run SET workflow_instance_id[\s\S]+EXISTS \(SELECT 1 FROM repository admission_repository[\s\S]+admission_repository\.github_access_state = 'active'/);
  });

  it('cancels admitted workloads when GitHub repository access is revoked', async () => {
    const webhook = await readFile(new URL('../worker/github-webhook.ts', import.meta.url), 'utf8');
    expect(webhook).toContain("settings.github_access_state !== 'active'");
    expect(webhook).toContain("outcome = 'access_revoked'");
    expect(webhook).toContain('cancellations[index]?.meta.changes');
    expect(webhook).toContain("'GitHub repository access was revoked.'");
    expect(webhook).toContain('instance.terminate()');
    expect(webhook).toContain('instance.status()');
    expect(webhook).toContain("event: 'access_revocation_terminal_workflow'");
    expect(webhook).toContain("event: 'access_revocation_termination_failed'");
    expect(webhook).toContain('terminationFailures.length');
    expect(webhook).toContain("workflow_instance_id = NULL");
  });

  it('admits only public HTTPS QA origins outside credential-bearing hosts', () => {
    const appUrl = 'https://juror-cloud.example.workers.dev';
    expect(unsafeQaOrigin(['https://staging.example.com'], appUrl)).toBeNull();
    for (const origin of [
      'http://staging.example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://service.internal',
      'https://api.openai.com',
      appUrl,
    ]) expect(unsafeQaOrigin([origin], appUrl)).toBe(origin);
  });
});
