import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGenericOpenAI } from '../src/harness/generic-openai.js';
import type { RunContext } from '../src/types.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function context(maxTurns: number): RunContext {
  const repoDir = mkdtempSync(join(tmpdir(), 'juror-generic-repo-'));
  dirs.push(repoDir);
  const scratchDir = mkdtempSync(join(tmpdir(), 'juror-generic-scratch-'));
  dirs.push(scratchDir);
  mkdirSync(scratchDir, { recursive: true });
  return {
    repoDir,
    scratchDir,
    findingsPath: join(scratchDir, 'findings.json'),
    promptPath: join(scratchDir, 'prompt.md'),
    prompt: 'review this',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    args: {},
    env: { TEST_API_KEY: 'test-only' },
    timeoutMs: 60_000,
    budgetUsd: null,
    maxTurns,
  };
}

const REPORT = {
  merge_confidence: 5,
  confidence_reason: 'No defects found.',
  summary: 'Reviewed the change.',
  highlights: [],
  file_overviews: [],
  sequence_diagram: null,
  async_contracts: [],
  findings: [],
};

function completion(message: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('generic OpenAI turn budget', () => {
  it('reports the resolved model plus native usage, cache writes, and provider-charged cost', async () => {
    const ctx = context(0);
    ctx.providerKey = 'openrouter-key';
    ctx.model = 'openai/gpt-5.6-luna';
    ctx.args = { usage_cost: 'usd' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'openai/gpt-5.6-luna',
            choices: [{ message: { role: 'assistant', content: JSON.stringify(REPORT) } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
              cost: 0.0123,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await runGenericOpenAI(ctx);

    expect(result.resolvedModel).toBe('openai/gpt-5.6-luna');
    expect(result.usageSource).toBe('provider');
    expect(result.usage).toEqual({ uncachedIn: 70, cacheRead: 20, cacheWrite: 10, out: 7 });
    expect(result.reportedCostUsd).toBe(0.0123);
    expect(JSON.stringify(result)).not.toContain('openrouter-key');
  });

  it('uses the runner-resolved provider key when passthrough env makes inference ambiguous', async () => {
    const ctx = context(0);
    ctx.providerKey = 'resolved-provider-key';
    ctx.env = { TEST_API_KEY: 'wrong-inferred-key', EXTRA_SETTING: 'also-non-system' };
    const fetchMock = vi.fn().mockResolvedValue(
      completion({ role: 'assistant', content: JSON.stringify(REPORT) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runGenericOpenAI(ctx);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer resolved-provider-key');
  });

  it('forwards an allowlisted reasoning effort without forwarding unsafe values', async () => {
    const ctx = context(0);
    ctx.args = { reasoning_effort: 'high' };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(completion({ role: 'assistant', content: JSON.stringify(REPORT) })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runGenericOpenAI(ctx);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      reasoning_effort: 'high',
    });

    ctx.args = { reasoning_effort: 'high; exfiltrate' };
    await runGenericOpenAI(ctx);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty('reasoning_effort');
  });

  it('does not present a partial provider charge as the complete reported cost', async () => {
    const ctx = context(0);
    ctx.args = { usage_cost: 'usd' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          model: 'first/model',
          choices: [{ message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            }],
          } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          model: 'first/model',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(REPORT) } }],
          usage: { prompt_tokens: 20, completion_tokens: 3 },
        }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runGenericOpenAI(ctx);

    expect(result.reportedCostUsd).toBeNull();
    expect(result.diagnostics).toContain(
      'provider omitted charged cost for at least one turn — estimating from token usage',
    );
  });

  it('continues past one tool round when zero disables the step cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(completion({ role: 'assistant', content: JSON.stringify(REPORT) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runGenericOpenAI(context(0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.turns).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.report).toEqual(REPORT);
  });

  it('still honours an explicitly configured positive cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            },
          ],
        }),
      ),
    );

    const result = await runGenericOpenAI(context(1));

    expect(result.turns).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toContain(
      'generic-openai stopped at the 1-turn limit with tool calls pending',
    );
  });
});

describe('generic OpenAI filesystem boundary', () => {
  it('refuses writes anywhere except the exact findings file', async () => {
    const ctx = context(0);
    const victim = join(ctx.repoDir, 'dirty.ts');
    writeFileSync(victim, 'user work', 'utf8');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: victim, content: 'overwritten' }),
            },
          }],
        }),
      )
      .mockResolvedValueOnce(completion({ role: 'assistant', content: JSON.stringify(REPORT) }));
    vi.stubGlobal('fetch', fetchMock);

    await runGenericOpenAI(ctx);

    expect(readFileSync(victim, 'utf8')).toBe('user work');
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('write_file may only write');
  });

  it('does not follow repository symlinks outside the read root', async () => {
    const ctx = context(0);
    const outside = mkdtempSync(join(tmpdir(), 'juror-generic-secret-'));
    dirs.push(outside);
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'NEVER_EXPOSE_THIS', 'utf8');
    symlinkSync(secret, join(ctx.repoDir, 'leak.txt'));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'leak.txt' }) },
          }],
        }),
      )
      .mockResolvedValueOnce(completion({ role: 'assistant', content: JSON.stringify(REPORT) }));
    vi.stubGlobal('fetch', fetchMock);

    await runGenericOpenAI(ctx);

    const secondRequest = String(fetchMock.mock.calls[1]?.[1]?.body);
    expect(secondRequest).toContain('refused');
    expect(secondRequest).not.toContain('NEVER_EXPOSE_THIS');
  });

  it('treats grep patterns literally instead of evaluating untrusted regular expressions', async () => {
    const ctx = context(0);
    writeFileSync(join(ctx.repoDir, 'long.txt'), `${'a'.repeat(100_000)}!`, 'utf8');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'grep', arguments: JSON.stringify({ pattern: '(a+)+$' }) },
          }],
        }),
      )
      .mockResolvedValueOnce(completion({ role: 'assistant', content: JSON.stringify(REPORT) }));
    vi.stubGlobal('fetch', fetchMock);

    await runGenericOpenAI(ctx);

    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('no matches');
  });
});
