import { ContainerProxy, Sandbox } from '@cloudflare/sandbox';
import type { OutboundHandlerContext } from '@cloudflare/containers';
import { decryptWorkspaceSecret } from './crypto';
import type { Env } from './env';
import { createInstallationToken, installationIdForRun } from './github';
import { sandboxCodeWhaleReleaseRequestAllowed, sandboxGithubRequestAllowed, type SandboxRunParams } from './github-egress';

export { ContainerProxy };

export class JurorSandbox extends Sandbox<Env> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ['github.com', 'api.github.com', 'api.openai.com', 'api.anthropic.com', 'api.x.ai', 'api.deepseek.com', 'api.fireworks.ai', 'openrouter.ai', 'api.scaleway.ai', 'api.moonshot.ai'];
  sleepAfter = '10m';
}

export class ReviewSandbox extends JurorSandbox {}
export class QaSandbox extends JurorSandbox {}

const jurorOutboundHandlers = {
  authenticatedGithub: async (request: Request, env: Env, context: OutboundHandlerContext<SandboxRunParams>) => {
    if (!sandboxGithubRequestAllowed(request, context.params)) return new Response('GitHub operation denied', { status: 403 });
    if (sandboxCodeWhaleReleaseRequestAllowed(request)) {
      const releaseAsset = new Request(request, { redirect: 'follow' });
      releaseAsset.headers.delete('authorization');
      releaseAsset.headers.set('user-agent', 'juror-cloud-runtime-installer/1');
      return fetch(releaseAsset);
    }
    const runId = context.params.runId;
    const installationId = await installationIdForRun(env, runId);
    const token = await createInstallationToken(env, installationId);
    // Returning redirects to the Sandbox keeps every hop subject to the host policy.
    // Following them here would let an allowlisted host turn this Worker into an SSRF
    // proxy to a destination that the Sandbox itself was never allowed to contact.
    const next = new Request(request, { redirect: 'manual' });
    next.headers.set('authorization', new URL(request.url).hostname === 'api.github.com' ? `Bearer ${token}` : `Basic ${btoa(`x-access-token:${token}`)}`);
    next.headers.set('user-agent', 'juror-cloud-runner/1');
    return fetch(next);
  },
  authenticatedProvider: async (request: Request, env: Env) => {
    const next = new Request(request, { redirect: 'manual' });
    const hostname = new URL(request.url).hostname;
    if (hostname === 'api.anthropic.com' && env.ANTHROPIC_API_KEY) next.headers.set('x-api-key', env.ANTHROPIC_API_KEY);
    else {
      const token = hostname === 'api.openai.com' ? env.OPENAI_API_KEY
        : hostname === 'api.x.ai' ? env.XAI_API_KEY
          : hostname === 'api.deepseek.com' ? env.DEEPSEEK_API_KEY
            : hostname === 'api.fireworks.ai' ? env.FIREWORKS_API_KEY
              : hostname === 'openrouter.ai' ? env.OPENROUTER_API_KEY
                : hostname === 'api.scaleway.ai' ? env.SCW_SECRET_KEY
                  : hostname === 'api.moonshot.ai' ? env.MOONSHOT_API_KEY
                    : undefined;
      if (!token) return new Response('Provider not configured', { status: 503 });
      next.headers.set('authorization', `Bearer ${token}`);
    }
    return fetch(next);
  },
  qaTarget: async (request: Request, env: Env, context: OutboundHandlerContext<SandboxRunParams>) => {
    const row = await env.DB.prepare(`SELECT r.workspace_id, rs.qa_allowed_origins_json, rs.qa_session_bootstrap_json, rs.qa_session_bootstrap_ciphertext, rs.qa_secret_headers_ciphertext, rs.qa_reset_hook_ciphertext FROM run r JOIN repository_settings rs ON rs.repository_id = r.repository_id WHERE r.id = ?`)
      .bind(context.params.runId).first<{ workspace_id: string; qa_allowed_origins_json: string; qa_session_bootstrap_json: string | null; qa_session_bootstrap_ciphertext: string | null; qa_secret_headers_ciphertext: string | null; qa_reset_hook_ciphertext: string | null }>();
    if (!row) return new Response('Unknown QA run', { status: 403 });
    const requested = new URL(request.url);
    const allowed = (JSON.parse(row.qa_allowed_origins_json) as string[]).some((origin) => new URL(origin).origin === requested.origin);
    if (!allowed) return new Response('Origin denied', { status: 403 });
    const next = new Request(request, { redirect: 'manual' });
    if (row.qa_session_bootstrap_json && row.qa_session_bootstrap_ciphertext) {
      const bootstrap = JSON.parse(row.qa_session_bootstrap_json) as { url: string };
      if (requested.toString() === new URL(bootstrap.url).toString()) {
        const secret = await decryptWorkspaceSecret(env, row.workspace_id, row.qa_session_bootstrap_ciphertext);
        next.headers.set('authorization', `Bearer ${secret}`);
      }
    }
    if (row.qa_secret_headers_ciphertext) {
      const headers = JSON.parse(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_secret_headers_ciphertext)) as Array<{ name: string; value: string; origins: string[] }>;
      for (const header of headers) if (header.origins.some((origin) => new URL(origin).origin === requested.origin)) next.headers.set(header.name, header.value);
    }
    if (row.qa_reset_hook_ciphertext) {
      const reset = JSON.parse(await decryptWorkspaceSecret(env, row.workspace_id, row.qa_reset_hook_ciphertext)) as { url: string; secretHeaders: Array<{ name: string; value: string; format: 'bearer' | 'raw' }> };
      if (requested.toString() === new URL(reset.url).toString()) {
        for (const header of reset.secretHeaders) next.headers.set(header.name, header.format === 'bearer' ? `Bearer ${header.value}` : header.value);
      }
    }
    return fetch(next);
  },
};

// @cloudflare/containers stores named outbound handlers by the exact runtime
// class name. They are not inherited from JurorSandbox's registry entry, so
// every Durable Object class referenced by wrangler must register them.
JurorSandbox.outboundHandlers = jurorOutboundHandlers;
ReviewSandbox.outboundHandlers = jurorOutboundHandlers;
QaSandbox.outboundHandlers = jurorOutboundHandlers;
