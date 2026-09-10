/**
 * generic-openai — the escape hatch from design §5.4.
 *
 * Not every model has a native agent harness, and harness churn is real: a CLI that works
 * today ships a breaking flag next month. This adapter drives any OpenAI-compatible
 * `/chat/completions` endpoint through our own small read/grep/list/write tool loop, so
 * adding a model is a config edit rather than a pull request. It has a lower ceiling than
 * a real harness — no kernel sandbox, and cost is provider-reported only when the endpoint
 * explicitly documents USD usage — which is exactly why it is the fallback and not the default.
 *
 * It is also the only adapter that does not spawn a process, so `runner.ts` special-cases
 * `id === 'generic-openai'` and calls `runGenericOpenAI()` instead of command/parse.
 */

import {
  type Dirent,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type {
  CanonicalUsage,
  Harness,
  HarnessCommand,
  HarnessIO,
  HarnessLocation,
  HarnessResult,
  ModelReport,
  RunContext,
} from '../types.js';
import { parseModelReport, readReportFile } from '../report.js';
import { log, redact } from '../util/log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
//
// A model that greps a monorepo can pull megabytes into the context window and bill us for
// every token, so every tool is capped rather than trusted.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 64 * 1024;
const MAX_FILES_SCANNED = 2_000;
const MAX_GREP_MATCHES = 100;
const MAX_LIST_ENTRIES = 200;
const RETRY_BACKOFF_MS = 1_500;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/** Env vars the runner passes through to every child; anything else must be the provider key. */
const SYSTEM_ENV = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'CI',
  'NODE_ENV',
  'SYSTEMROOT',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the repository. Output is truncated when large.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative or absolute path.' },
          start_line: { type: 'integer', description: '1-based first line to return.' },
          end_line: { type: 'integer', description: '1-based last line to return.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a literal, case-sensitive substring.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search. Defaults to the repo root.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries of a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 text file. Use this for the JSON findings report.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function nonNegativeNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `readReportFile` is another module's; a throw there must not fail the whole run. */
function readReportSafely(path: string): { report: ModelReport | null; problems: string[] } {
  try {
    return readReportFile(path);
  } catch (e) {
    return { report: null, problems: [e instanceof Error ? e.message : String(e)] };
  }
}

function parseTextSafely(text: string): { report: ModelReport | null; problems: string[] } {
  try {
    return parseModelReport(text);
  } catch (e) {
    return { report: null, problems: [e instanceof Error ? e.message : String(e)] };
  }
}

function realOrNearest(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(realOrNearest(parent), basename(absolute));
  }
}

function isInside(child: string, parent: string): boolean {
  const c = realOrNearest(child);
  const p = realOrNearest(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Every path a model hands us is untrusted text — `../../.ssh/id_rsa` is one hallucination
 * away. Resolve symlinks (or the nearest existing parent), then prefix-check against the
 * roots the run is allowed to read.
 * Rejection is a tool-result string, never a throw: a refused path should teach the model to
 * pick a different one, not abort the review.
 */
function confine(p: unknown, roots: string[], base: string): { abs: string } | { error: string } {
  const raw = typeof p === 'string' ? p : '';
  if (!raw.trim()) return { error: 'error: "path" is required and must be a non-empty string' };
  const abs = realOrNearest(resolve(base, raw));
  if (!roots.some((root) => isInside(abs, root))) {
    return { error: `error: refused — "${raw}" resolves outside the review workspace` };
  }
  return { abs };
}

function resolveApiKey(ctx: RunContext): string | null {
  // The runner resolves the configured secret before constructing the child env. Prefer
  // that authoritative value: env_passthrough may legitimately add several non-system
  // variables, which makes inference ambiguous even though the provider key is known.
  const resolved = readString(ctx.providerKey);
  if (resolved) return resolved;
  const named = readString(ctx.args['api_key_env']) ?? readString(ctx.args['secret']);
  if (named) return readString(ctx.env[named]);
  // The runner hands each model an env holding only its own provider key plus PATH/HOME/etc,
  // so when the config names nothing, the single non-system entry is unambiguous.
  const candidates = Object.entries(ctx.env).filter(([k, v]) => !SYSTEM_ENV.has(k) && !!v.trim());
  return candidates.length === 1 ? readString(candidates[0]?.[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

function walkFiles(dir: string, budget: { left: number }, out: string[]): void {
  if (budget.left <= 0) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(resolve(dir, entry.name), budget, out);
    } else if (entry.isFile()) {
      budget.left -= 1;
      out.push(resolve(dir, entry.name));
    }
  }
}

function toolReadFile(args: Record<string, unknown>, roots: string[], base: string): string {
  const c = confine(args['path'], roots, base);
  if ('error' in c) return c.error;
  let text: string;
  try {
    text = readFileSync(c.abs, 'utf8');
  } catch (e) {
    return `error: cannot read ${relative(base, c.abs) || c.abs}: ${(e as Error).message}`;
  }

  const start = Math.max(1, Math.trunc(num(args['start_line'])) || 1);
  const endRaw = Math.trunc(num(args['end_line']));
  if (start > 1 || endRaw > 0) {
    const lines = text.split('\n');
    const end = endRaw > 0 ? Math.min(endRaw, lines.length) : lines.length;
    text = lines.slice(start - 1, end).join('\n');
  }

  if (text.length > MAX_READ_BYTES) {
    return `${text.slice(0, MAX_READ_BYTES)}\n… [truncated at ${MAX_READ_BYTES} bytes — request a line range]`;
  }
  return text || '(empty file)';
}

function toolGrep(args: Record<string, unknown>, roots: string[], base: string): string {
  const pattern = readString(args['pattern']);
  if (!pattern) return 'error: "pattern" is required';

  const dirArg = typeof args['path'] === 'string' && args['path'].trim() ? args['path'] : base;
  const c = confine(dirArg, roots, base);
  if ('error' in c) return c.error;

  const files: string[] = [];
  const budget = { left: MAX_FILES_SCANNED };
  try {
    if (statSync(c.abs).isDirectory()) walkFiles(c.abs, budget, files);
    else files.push(c.abs);
  } catch (e) {
    return `error: cannot search ${dirArg}: ${(e as Error).message}`;
  }

  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= MAX_GREP_MATCHES) break;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || !line.includes(pattern)) continue;
      hits.push(`${relative(base, file) || file}:${i + 1}: ${line.trim().slice(0, 300)}`);
      if (hits.length >= MAX_GREP_MATCHES) break;
    }
  }

  if (hits.length === 0) return 'no matches';
  const capped = hits.length >= MAX_GREP_MATCHES ? `\n… [capped at ${MAX_GREP_MATCHES} matches]` : '';
  const scanned = budget.left <= 0 ? `\n… [capped at ${MAX_FILES_SCANNED} files scanned]` : '';
  return hits.join('\n') + capped + scanned;
}

function toolListDir(args: Record<string, unknown>, roots: string[], base: string): string {
  const c = confine(args['path'], roots, base);
  if ('error' in c) return c.error;
  let entries: Dirent[];
  try {
    entries = readdirSync(c.abs, { withFileTypes: true });
  } catch (e) {
    return `error: cannot list ${relative(base, c.abs) || c.abs}: ${(e as Error).message}`;
  }
  const rows = entries
    .slice(0, MAX_LIST_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const more = entries.length > MAX_LIST_ENTRIES ? `\n… [${entries.length - MAX_LIST_ENTRIES} more]` : '';
  return (rows.join('\n') || '(empty directory)') + more;
}

function toolWriteFile(args: Record<string, unknown>, findingsPath: string, base: string): string {
  const raw = readString(args['path']);
  if (!raw) return 'error: "path" is required and must be a non-empty string';
  const abs = realOrNearest(resolve(base, raw));
  const expected = realOrNearest(findingsPath);
  if (abs !== expected) return `error: refused — write_file may only write ${findingsPath}`;
  const content = typeof args['content'] === 'string' ? args['content'] : '';
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  } catch (e) {
    return `error: cannot write ${relative(base, abs) || abs}: ${(e as Error).message}`;
  }
  return `wrote ${content.length} bytes to ${relative(base, abs) || abs}`;
}

function dispatchTool(
  name: string,
  rawArgs: string,
  readRoots: string[],
  findingsPath: string,
  base: string,
): string {
  let args: Record<string, unknown> = {};
  if (rawArgs.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (!isRecord(parsed)) return 'error: tool arguments must be a JSON object';
      args = parsed;
    } catch {
      return 'error: tool arguments were not valid JSON';
    }
  }
  switch (name) {
    case 'read_file':
      return toolReadFile(args, readRoots, base);
    case 'grep':
      return toolGrep(args, readRoots, base);
    case 'list_dir':
      return toolListDir(args, readRoots, base);
    case 'write_file':
      return toolWriteFile(args, findingsPath, base);
    default:
      return `error: unknown tool "${name}"`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/** One completion, with a single retry for the two failures that are usually transient. */
async function chat(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  diagnostics: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastError = 'no response';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const text = await res.text();

    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}: ${redact(text.slice(0, 300))}`;
      if (attempt === 0) {
        diagnostics.push(`generic-openai got HTTP ${res.status}, retrying once`);
        await sleep(RETRY_BACKOFF_MS);
        if (signal?.aborted) throw new Error('generic-openai aborted');
        continue;
      }
      throw new Error(`generic-openai request failed — ${lastError}`);
    }
    if (!res.ok) throw new Error(`generic-openai request failed — HTTP ${res.status}: ${redact(text.slice(0, 300))}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`generic-openai returned non-JSON: ${redact(text.slice(0, 200))}`);
    }
    if (!isRecord(parsed)) throw new Error('generic-openai returned a JSON value that was not an object');
    return parsed;
  }

  throw new Error(`generic-openai request failed — ${lastError}`);
}

function readToolCalls(message: Record<string, unknown>): ToolCall[] {
  const raw = message['tool_calls'];
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item['function']) ? item['function'] : null;
    const name = fn ? readString(fn['name']) : null;
    if (!name) continue;
    calls.push({
      id: typeof item['id'] === 'string' ? item['id'] : `call_${calls.length}`,
      type: 'function',
      function: { name, arguments: typeof fn?.['arguments'] === 'string' ? fn['arguments'] : '{}' },
    });
  }
  return calls;
}

const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high']);

/**
 * `args` is user configuration, not an arbitrary provider-body passthrough. Keep the
 * allowlist tight so a config cannot smuggle endpoint-specific controls into a request.
 */
function requestOptions(args: Record<string, unknown>): Record<string, string> {
  const reasoningEffort = readString(args['reasoning_effort']);
  return reasoningEffort && REASONING_EFFORTS.has(reasoningEffort)
    ? { reasoning_effort: reasoningEffort }
    : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────────

export async function runGenericOpenAI(ctx: RunContext, signal?: AbortSignal): Promise<HarnessResult> {
  const baseUrl = readString(ctx.baseUrl) ?? readString(ctx.args['base_url']);
  if (!baseUrl) throw new Error('generic-openai requires `base_url` in the model config');
  const apiKey = resolveApiKey(ctx);
  if (!apiKey) {
    throw new Error(
      'generic-openai could not resolve an API key — set `args.api_key_env` to the env var holding it',
    );
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const readRoots = [realOrNearest(ctx.repoDir)];
  mkdirSync(ctx.scratchDir, { recursive: true });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a code review agent. You have read-only tools over a repository and one exact writable findings file.',
        `Relative paths resolve against ${ctx.repoDir}. Paths outside the workspace are refused.`,
        `When you are finished, call write_file to write your JSON report to ${ctx.findingsPath}, then reply with a one-line confirmation and no further tool calls.`,
      ].join(' '),
    },
    { role: 'user', content: ctx.prompt },
  ];

  const usage: CanonicalUsage = { uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
  const diagnostics: string[] = [];
  const deadline = Date.now() + ctx.timeoutMs;
  let sawUsage = false;
  let reportedCostUsd = 0;
  let usageTurns = 0;
  let costedTurns = 0;
  const resolvedModels = new Set<string>();
  let truncated = false;
  let rawText = '';
  let turns = 0;

  while (ctx.maxTurns <= 0 || turns < ctx.maxTurns) {
    if (signal?.aborted) {
      truncated = true;
      diagnostics.push('generic-openai aborted');
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      truncated = true;
      diagnostics.push('generic-openai hit its wall-clock timeout');
      break;
    }

    const data = await chat(
      url,
      apiKey,
      { model: ctx.model, messages, tools: TOOLS, tool_choice: 'auto', ...requestOptions(ctx.args) },
      remaining,
      diagnostics,
      signal,
    );
    turns += 1;

    const resolvedModel = readString(data['model']);
    if (resolvedModel) resolvedModels.add(resolvedModel);

    const u = isRecord(data['usage']) ? data['usage'] : null;
    if (u) {
      sawUsage = true;
      usageTurns += 1;
      const details = isRecord(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : null;
      const cached = num(details ? details['cached_tokens'] : u['cached_tokens']);
      const cacheWrite = num(details ? details['cache_write_tokens'] : u['cache_write_tokens']);
      // `prompt_tokens` INCLUDES the cached prefix; billing the whole thing at the uncached
      // rate is the 10x overbilling bug from design §5.2.
      usage.uncachedIn += Math.max(0, num(u['prompt_tokens']) - cached - cacheWrite);
      usage.cacheRead += cached;
      usage.cacheWrite += cacheWrite;
      usage.out += num(u['completion_tokens']);

      if (ctx.args['usage_cost'] === 'usd') {
        const cost = nonNegativeNumber(u['cost']);
        if (cost !== null) {
          costedTurns += 1;
          reportedCostUsd += cost;
        }
      }
    }

    const choices = data['choices'];
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = isRecord(first) && isRecord(first['message']) ? first['message'] : null;
    if (!message) {
      diagnostics.push('generic-openai response carried no assistant message');
      break;
    }

    const content = typeof message['content'] === 'string' ? message['content'] : '';
    if (content.trim()) rawText = content;

    const toolCalls = readToolCalls(message);
    messages.push({
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      const result = dispatchTool(
        call.function.name,
        call.function.arguments,
        readRoots,
        ctx.findingsPath,
        ctx.repoDir,
      );
      if (result.startsWith('error: refused')) diagnostics.push(result);
      log.debug(`generic-openai tool ${call.function.name} → ${result.length} bytes`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }

    if (ctx.maxTurns > 0 && turns >= ctx.maxTurns) {
      truncated = true;
      diagnostics.push(`generic-openai stopped at the ${ctx.maxTurns}-turn limit with tool calls pending`);
    }
  }

  if (resolvedModels.size > 1) {
    diagnostics.push(`routing provider returned multiple model identities: ${[...resolvedModels].join(', ')}`);
  }
  if (ctx.args['usage_cost'] === 'usd' && usageTurns > costedTurns) {
    diagnostics.push('provider omitted charged cost for at least one turn — estimating from token usage');
  }

  // The file written through the write_file tool wins; the fenced-block parse of the final
  // message is the fallback for a model that answered in prose instead.
  const file = readReportSafely(ctx.findingsPath);
  let report = file.report;
  diagnostics.push(...file.problems);
  if (!report && rawText.trim()) {
    const fromText = parseTextSafely(rawText);
    diagnostics.push(...fromText.problems);
    if (fromText.report) {
      report = fromText.report;
      diagnostics.push('findings file missing — recovered the report from the final message');
    }
  }

  return {
    report,
    usage: sawUsage ? usage : null,
    reportedCostUsd: usageTurns > 0 && costedTurns === usageTurns ? reportedCostUsd : null,
    ...(resolvedModels.size ? { resolvedModel: [...resolvedModels].join(', ') } : {}),
    ...(sawUsage ? { usageSource: 'provider' as const } : {}),
    turns,
    truncated,
    rawText,
    diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

const NOT_A_SUBPROCESS = 'generic-openai does not spawn a subprocess — call runGenericOpenAI(ctx) instead';

export const genericOpenAIHarness = {
  id: 'generic-openai',
  label: 'Generic OpenAI',

  // Nothing to find on PATH: this adapter runs in-process against global fetch.
  async locate(_env?: Record<string, string | undefined>): Promise<HarnessLocation> {
    return { binPath: process.execPath, version: process.version, warnings: [] };
  },

  command(_ctx: RunContext): HarnessCommand {
    throw new Error(NOT_A_SUBPROCESS);
  },

  parse(_io: HarnessIO, _ctx: RunContext): HarnessResult {
    throw new Error(NOT_A_SUBPROCESS);
  },
} satisfies Harness;
