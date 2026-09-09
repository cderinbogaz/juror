<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/hero-light.svg">
  <img alt="Juror — frontier models review your pull request in parallel" src="assets/hero-light.svg">
</picture>

<br>

[![CI](https://img.shields.io/github/actions/workflow/status/juror-ai/juror/ci.yml?branch=main&style=flat-square&label=ci&labelColor=1b1f24&color=3fb950)](https://github.com/juror-ai/juror/actions/workflows/ci.yml) [![Juror reviews Juror](https://img.shields.io/badge/dogfooded-juror%20reviews%20juror-F2B33D?style=flat-square&labelColor=1b1f24)](.github/workflows/juror.yml) [![Node](https://img.shields.io/badge/node-%E2%89%A520-8593a8?style=flat-square&labelColor=1b1f24)](package.json) [![License](https://img.shields.io/badge/license-MIT-8593a8?style=flat-square&labelColor=1b1f24)](LICENSE)

</div>

**Juror is a GitHub Action that asks several frontier models to review each pull request in
parallel. It combines duplicate findings into one report and posts the review, merge score, and
cost receipt back to GitHub.**

## Juror Cloud

This repository also contains [`cloud/`](cloud/), a deployable hosted companion with GitHub and Google sign-in, GitHub App automation, a lean findings and run inbox, isolated Cloudflare Sandbox execution, post-merge staging QA, and transparent Stripe metered billing. The open-source Action and CLI remain independently usable, while repositories connected to Cloud use hosted execution exclusively.

See the [Juror Cloud deployment guide](cloud/README.md) for the GitHub App permissions, Cloudflare resources, secrets, billing meter, and verification commands.

## ChatGPT, Codex, and MCP

Juror Cloud is also available as a remote, OAuth-protected Streamable HTTP MCP server at `https://app.juror.dev/mcp`. Add that URL in an MCP-compatible client, sign in with your Juror Cloud account, list your workspaces first, and then inspect concise review summaries.

The integration is intentionally narrower than the GitHub Action and local CLI:

- **Juror Cloud MCP / Plugin** — inspects workspace-scoped findings and hosted runs. It can prepare and, after explicit user confirmation, start or rerun an existing hosted Juror Cloud review. It never accesses arbitrary local repositories or returns raw diffs, full reports, artifacts, screenshots, credentials, or prompt text.
- **Juror Cloud** — the hosted service that owns workspace membership, GitHub App access, isolated execution, retention, and billing.
- **GitHub Action and CLI** — run from your repository or local environment using the configuration you control. Do not run the hosted service alongside a Juror GitHub Action for the same repository.

Starter prompts:

- “Show my Juror workspaces and review findings.”
- “Summarize open P0 and P1 Juror findings in this workspace.”
- “Prepare a hosted review for this open PR; show me the SHA and cost warning before starting.”

The canonical registry metadata is [`registry/server.json`](registry/server.json). See the [directory submission record](docs/mcp-directory-submissions.md) for publication status and the required external verification steps.

## Add Juror to your repository

Start from the [Juror AI listing in GitHub Marketplace](https://github.com/marketplace/actions/juror-ai):
click **Use latest version** to add it to a workflow. If you prefer to add it directly, create
`.github/workflows/juror.yml` with this ready-to-run workflow:

```yaml
name: Juror

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: juror-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Provider secrets are never exposed to code from forks.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          fetch-depth: 0
          filter: blob:none
      - uses: juror-ai/juror@178a16d6fa3a1b868094bc4236d42fb8e442ea6a # v1.3.3
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          JUROR_OPENAI_API_KEY: ${{ secrets.JUROR_OPENAI_API_KEY }}
          JUROR_FIREWORKS_API_KEY: ${{ secrets.JUROR_FIREWORKS_API_KEY }}
```

Then add at least one provider key in **Settings → Secrets and variables → Actions**. One key
starts a review; adding a second provider makes the default `fast` preset a cross-model jury:

```bash
gh secret set JUROR_OPENAI_API_KEY
gh secret set JUROR_FIREWORKS_API_KEY
```

Commit the workflow and open a pull request. Juror immediately posts a sticky *Juror is
reviewing…* comment, then replaces it with the findings, merge score, and bill. Every Action
input besides `github-token` is optional; see [`action.yml`](action.yml) for `preset`, `models`,
`config`, `cost-target-usd`, `post`, and `pr-number`.

The example pins both Actions to immutable commits. The Marketplace's generated snippet is a
convenient starting point; use an immutable SHA in the committed workflow to keep the reviewed
Action version fixed.

<details><summary><b>Prefer a guided CLI setup or a local review?</b></summary><br>

The CLI can generate the same SHA-pinned workflow, inspect the plan first, and optionally upload
provider keys through the GitHub CLI:

```bash
export JUROR_OPENAI_API_KEY=…
npx juror-ai init --set-secrets

# Or inspect the planned workflow and secrets without changing anything.
npx juror-ai init --dry-run
```

To review an existing pull request locally without creating a workflow:

```bash
npx juror-ai review --pr 1234 --repo owner/name          # prints to your terminal
npx juror-ai review --pr 1234 --repo owner/name --post   # also posts the review
```

The optional `starter` preset uses one `JUROR_OPENROUTER_API_KEY` to reach two model families:

```bash
npx juror-ai init --preset starter --set-secrets
```

</details>

---

> ### Benchmark evidence: Juror Fast found 4× more adjudicated P0–P2 defects than Greptile
>
> On the bundled production-PR seed, Juror Fast found **4/6 (66.7%)** P0–P2 defects at
> **100% precision**. Greptile found **1/6 (16.7%)** at **50% precision**.
>
> | Reviewer | P0–P2 recall | Precision |
> |---|---:|---:|
> | **Juror Fast** | **66.7% (4/6)** | **100% (4/4)** |
> | Greptile | 16.7% (1/6) | 50% (1/2) |
>
> This is a manually adjudicated, one-PR seed—not a statistically sufficient replacement
> benchmark. Inspect the [corpus](benchmarks/platform-10359.json) and
> [methodology](docs/benchmarking.md), or reproduce it with
> `juror benchmark --file benchmarks/platform-10359.json`.

### Optional post-merge browser QA

Juror can also watch merged pull requests, plan affected user journeys, and exercise the live
staging or branch deployment through Playwright with structured evidence and, for runs without
authentication or supplied browser state, videos. Authenticated runs still interact with the
product and evaluate plan-bound checkpoints, but each admitted page-dependent browser call returns the
same sealed acknowledgement and completed-attempt outcomes stay hidden from the model:

```bash
npx juror-ai init --qa --set-secrets --target-url https://staging.example.com
```

For a product that exposes a fixed-identity synthetic support-session endpoint, Juror can mint a
fresh, single-use login URL for every attempt through `qa.auth.session_bootstrap`. This v1 mode is
restricted to the configured canonical staging origin: set `qa.target.preview_fallback: false`,
and do not expect the session to follow a branch deployment with a different origin. Optional
`qa.auth.browser_secret_headers` are injected only into requests to their exact configured origins,
which supports a staging Cloudflare Access service token and a separate WAF header without exposing
either credential to other hosts. All logical secrets remain inside `JUROR_QA_SECRETS_B64`;
authenticated visual and trace evidence stays off and browser observations stay sealed.

Use the fixed synthetic-session service, not an arbitrary-user testing-login bypass. The
[post-merge QA quickstart](docs/2026-08-18-post-merge-qa-quickstart.md#staging-support-session-bootstrap)
includes a generic staging example and the required gateway prerequisite.

Repositories can also configure trusted `qa.testability.early_exit_paths` globs for paths that
never justify browser QA. Juror returns a neutral, not-scored `no_testable_surface` result before
deployment lookup, secret loading, model startup, or Playwright only when every path in the
complete changed-file manifest matches. The default is empty because an infrastructure or docs
tree can still affect a product in some repositories.

The target's exact origin is added to the browser allowlist automatically; repeat `--allow-origin`
for any additional API origin the tested product needs. Without either target option, init writes a
safely disabled QA policy and explains how to enable it. The released action verifies its container
provenance before credential handoff. See the
[post-merge QA quickstart](docs/2026-08-18-post-merge-qa-quickstart.md) for the fastest local loop,
staging target setup, synthetic login credentials, and result meanings.

By default, a policy without a trusted reset hook runs navigation-only journeys. A change whose
affected journey requires interaction is reported as blocked, not as having no browser surface.
Reviewed policy can set `qa.sandbox.interaction_policy: read_only` to enable click, fill, press,
select, and check while Juror blocks non-safe HTTP methods and outbound WebSocket messages after the
first action. Persistent mutations still require a dedicated synthetic tenant and
`qa.sandbox.reset`.
Each checkpoint fixes its assertion kind and exact locator or URL matcher before the browser opens;
authenticated or supplied-state scenarios always run a second sealed attempt, and the controller
derives the result from its private ledger. The final report necessarily reveals one bounded
pass/fail result per predeclared checkpoint, so connect QA only to a synthetic account and tenant
containing no production data or other sensitive records.

---

## Why

Single-model PR bots have three problems, in order of how much they cost you:

1. **Blind spots.** Every model misses different bugs.
2. **Duplication.** Multiple reviewers often describe the same defect in different words.
3. **Opacity.** You pay per seat or per PR and never see what the inference actually cost.

Juror runs several models, uses code-aware similarity plus a conservative referee to
deduplicate reports about the same defect, and defaults to high recall: every unique
eligible finding is shown. Teams that
prefer fewer, higher-confidence findings can switch `review.publish_mode` to `consensus`
and use model agreement as a precision filter.

And there is no index and no SaaS. A coding agent doesn't need a prebuilt semantic index:
the supported agent harnesses all ship repository read/search tools and will go inspect the
callers of the function you changed. You get repo-wide context for the price of a few tool
calls, with zero indexing infrastructure, zero staleness, and no code leaving the runner
beyond the model API call itself.

**Non-goals.** Not an autofix bot. Not a linter (yours is better and free). Not a chat
interface. It reviews a diff and posts findings.

---

## How it works

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/pipeline-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/pipeline-light.svg">
  <img alt="The diff fans out to a jury of models; their findings are anchored, blocked, merged and refereed into one comment" src="assets/pipeline-light.svg">
</picture>
</div>

Each model gets the diff, its own private scratch directory, and read-only access to a clean
detached checkout. Their findings then go through five lossless merge stages — cheapest first,
with a model call only for possible semantic duplicates:

1. **Anchor** *(free)* — snap every finding to a line the diff actually adds or modifies.
   Findings landing outside the diff are reported separately, never silently dropped.
2. **Block** *(free)* — group by file, then by overlapping line window.
3. **Exact collapse** *(free)* — normalized identical reports, or identical structured
   trigger/mechanism/consequence/fix claims, collapse without inference.
4. **Similarity + referee** *(cheap)* — weighted prose/symbol similarity nominates possible
   duplicates. A small call per block merges them only when the faulty mechanism and fix
   match and their affected behavior substantially overlaps; extra entry points or effects
   in one report do not make the same bug new. A malformed partition is retried once, then
   fails open to separate findings so deduplication can never hide a report.
5. **Coverage audit** *(free)* — prove every raw atomic finding belongs to exactly one final
   published or explicitly suppressed result. Any accounting failure discards the merge
   decisions and falls back to lossless singletons.

In `consensus` mode an additional **verify** stage runs: eligible P0/P1 and eligible
single-model findings get an adversarial refutation pass. The verifier is asked to
*refute*, and defaults to refuted when the evidence isn't clear.

---

## What it posts

One sticky summary comment, and inline comments delivered as **a single batched review** —
one notification, not twelve. Roughly:

> #### Juror Review
>
> Adds SSE `event: error` detection to the reasoning stream so mid-stream provider failures
> retry instead of ending the turn as a silent success.
>
> #### Merge Confidence: 4/5
>
> <sub>Model votes: GPT-5.6 Terra `4` · Grok 4.5 `5` · Kimi K3 `4` → median **4**, capped at **4.5** by 1 confirmed P2.</sub>
>
> | | Severity | Location | Finding | Agreement |
> |---|---|---|---|---|
> | 1 | P1 | `src/stream/parse.ts:212` | Error branch leaves the reader unlocked | `●●●` 3/3 |
> | 2 | P2 | `src/stream/parse.ts:424` | Same swallow pattern not ported to the sibling class | `●○○` 1/3 |
>
> <details><summary>2 findings suppressed — below severity floor</summary><br>
>
> | Location | Finding | Raised by | Why suppressed |
> |---|---|---|---|
> | `src/stream/parse.ts:387` | `chunks_emitted` hardcoded on error events | GPT-5.6 Terra, Kimi K3 | below severity floor |
>
> </details>
>
> <details><summary><b>💸 This review cost $0.91</b> · 3 models · 2m14s</summary><br>
>
> | Model | Harness | Input | Cached | Output | Cost | Source |
> |---|---|---|---|---|---|---|
> | `GPT-5.6 Terra` | Codex | 39.8k | 12.1k | 8.9k | $0.34 | estimated |
> | `Grok 4.5` | Grok Build | 40.1k | 0 | 5.2k | $0.38 | reported |
> | `Kimi K3` | Kimi Code | 42.0k | 10.0k | 4.2k | $0.19 | estimated |
> | `referee (1 call)` | opencode | — | — | — | $0.0011 | reported |
> | **Total** | | **122k** | **22.1k** | **18.3k** | **$0.91** | |
>
> </details>

Plus a file-by-file overview and an optional sequence diagram of the changed flow.

With `--post`, Juror immediately creates one sticky **Juror is reviewing…** comment with an
animated working indicator and a short progress checklist. The finished summary replaces
that same comment in place; failed runs replace it with a terminal error state instead of
leaving a spinner behind forever.

---

## Install

### GitHub Action

Install from the [Juror AI GitHub Marketplace listing](https://github.com/marketplace/actions/juror-ai)
or copy the [workflow above](#add-juror-to-your-repository). `npx juror-ai init` is an optional
guided way to generate that workflow and set secrets; it is not required to use the Action.
Beyond `github-token`, every Action input is optional: `preset`, `models`, `config`,
`cost-target-usd`, `post` (set `false` for a dry run), and `pr-number`. They are documented with
their defaults in [`action.yml`](action.yml).

### Locally

The same binary, the same code path, no CI-only surprises:

```bash
npm i -g juror-ai

juror review --base main                         # review your working branch
juror review --pr 1234 --repo owner/name         # review a PR, print to the terminal
juror review --pr 1234 --repo owner/name --post  # ...and post it
```

Put your keys in a `.env` beside the repo (it is loaded automatically and never committed).
Juror copies only committed/staged/tracked working changes into a detached model checkout,
so this untracked file is not inside any reviewer read root:

```
JUROR_ANTHROPIC_API_KEY=…
JUROR_OPENAI_API_KEY=…
JUROR_FIREWORKS_API_KEY=…
JUROR_XAI_API_KEY=…
JUROR_OPENROUTER_API_KEY=…
JUROR_SCALEWAY_API_KEY=…
```

---

## Supported models & harnesses

Juror normally drives each model through its **native agent harness**, so each one greps your
repo the way its vendor intended. The opt-in one-secret starter uses Juror's confined in-process
tool loop against OpenRouter instead; it preserves the same sealed checkout and exact findings
file boundary without installing another executable.

| Harness | CLI | Models | Reports cost | Sandbox |
|---|---|---|---|---|
| `claude-code` | `claude -p` | any Anthropic model | ✅ `total_cost_usd` | tool removal |
| `codex` | `codex exec` | any OpenAI model | ❌ → estimated | split filesystem profile (kernel) |
| `deepseek` | `codewhale exec` | DeepSeek models | ❌ → estimated from provider usage | read-only sandbox + tool allowlist |
| `opencode` | `opencode run` | anything on [models.dev](https://models.dev) — Fireworks, Groq, OpenRouter, … | ✅ per-step `cost` | tool removal |
| `grok-build` | `grok -p` | Grok models | ✅ `total_cost_usd` | Landlock |
| `kimi-code` | `kimi -p` | Kimi K3 on Fireworks | ❌ → estimated from session usage | tool allowlist + isolated runtime |
| `generic-openai` | *(in-process)* | any OpenAI-compatible endpoint | provider-reported when documented; otherwise estimated | path-confined tools |

DeepSeek models use the DeepSeek-native CodeWhale harness so interleaved reasoning survives
tool calls. To add **DeepSeek V4 Flash** on Fireworks to your jury:

```yaml
models:
  - id: deepseek-v4-flash-0731
    harness: deepseek
    harness_model: accounts/fireworks/models/deepseek-v4-flash-0731
    pricing_key: accounts/fireworks/models/deepseek-v4-flash-0731
    secret: JUROR_FIREWORKS_API_KEY
    args: { reasoning_effort: high }
```

Scaleway's European OpenAI-compatible endpoint is also built in as
`scaleway-deepseek-v4-flash-0731`. It uses `JUROR_SCALEWAY_API_KEY`, the
`deepseek-v4-flash-0731` model id, and `reasoning_effort: high`; select `ultra` or
add this route to an explicit jury:

```yaml
models:
  - id: scaleway-deepseek-v4-flash-0731
    harness: generic-openai
    secret: JUROR_SCALEWAY_API_KEY
    base_url: https://api.scaleway.ai/v1
    harness_model: deepseek-v4-flash-0731
    pricing_key: scaleway/deepseek-v4-flash-0731
    args: { reasoning_effort: high }
```

For a project-scoped or dedicated Scaleway deployment, replace `base_url` with its
public endpoint URL; do not put credentials in that URL.

---

## Configuration

Juror ships five jury presets. Models whose provider key is unavailable are skipped, so
`ultra` means every built-in model that can actually authenticate on that runner.

| Preset | Jury | Intended use |
|---|---|---|
| `starter` *(opt-in)* | GPT-5.6 Luna · DeepSeek V4 Flash through OpenRouter's confined generic harness | Two model families from one `JUROR_OPENROUTER_API_KEY`; awaiting benchmark promotion gate |
| `fast` **(default)** | GPT-5.6 Luna via Codex/OpenAI (`low`) · DeepSeek V4 Flash via DeepSeek/Fireworks (`high`) | Lean two-model jury |
| `balanced` | GPT-5.6 Terra via Codex/OpenAI (`max`) · Grok 4.5 via Grok Build/xAI (`high`) · Kimi K3 via Kimi Code/Fireworks (`max`) | Strong provider diversity without the full burn |
| `high` | GPT-5.6 Sol via Codex/OpenAI (`high`) · Opus 5 via Claude Code/Anthropic · Grok 4.5 via Grok Build/xAI (`high`) | Higher-confidence frontier jury |
| `ultra` | Every built-in model (eight total), including DeepSeek V4 Flash through Scaleway | Maximum coverage; highest token and cost use |

Select one in config, on the CLI, or in the Action:

```bash
juror review --preset fast --base main
juror review --preset starter --base main
juror review --mode ultra --pr 1234 --repo owner/name
```

```yaml
- uses: juror-ai/juror@178a16d6fa3a1b868094bc4236d42fb8e442ea6a # v1.3.3
  with:
    preset: high
```

`.juror.yml` lives at the repo root. Every key is optional; the defaults are what you see below.

```yaml
version: 1
preset: fast

consensus:
  min_agreement: all             # all (literal unanimity) | majority | <number>
  verify_solo_findings: true     # adversarially refute eligible solo findings
  # verify_model/referee_model default to a model included in the selected preset

review:
  publish_mode: all              # all (higher recall) | consensus (higher precision)
  severity_floor: P3             # include every severity by default
  max_inline_comments: 15
  paths_ignore: ["**/*.lock", "dist/**", "**/*.generated.*"]

budget:
  target_cost_usd_per_pr: 5.00   # planning target; actual spend remains in the receipt
  on_exceed: partial             # affordable subset | skip

output:
  sequence_diagram: true
  cost_receipt: true
  suppressed_findings: collapsed # collapsed | hidden | inline
```

An explicit `models:` list replaces the preset completely and creates a custom jury; it is
never merged with built-ins. `--models a,b` is different: it only narrows the selected preset
or custom jury for one run. `--preset` and its `--mode` alias override the config selection.

---

## Publishing: recall or precision

Publication is controlled independently from deduplication.

- `publish_mode: all` *(default, higher recall)* publishes every unique cluster at or above
  `severity_floor` (also P3 by default). Agreement is still shown, but it does not hide a
  finding.
- `publish_mode: consensus` *(higher precision)* applies the configured agreement and
  verification rules. The default `consensus.min_agreement: all` means every model must
  raise the finding.

With `min_agreement: all`, publication requires literal unanimity. If users deliberately
choose `majority` or a numeric threshold, serious findings retain the safety exceptions:

```
publish if  agreement >= configured min_agreement
        or (agreement >= 2 and severity in {P0,P1})
        or (agreement == 1 and severity in {P0,P1} and survived refutation)
```

Anything filtered out lands in the collapsed **suppressed** block with the reason. Nothing
is thrown away — that transparency is what makes the optional precision filter trustworthy.

### Shadow benchmark

Replacement decisions can be evaluated with a manually adjudicated corpus:

```bash
juror benchmark --file benchmarks/platform-10359.json
```

The report compares P0–P2 recall, overall recall, precision, duplicate rate, measured cost,
and latency for every reviewer. See [the benchmarking protocol](docs/benchmarking.md); the
bundled PR #10359 case is a seed, not a sufficient replacement benchmark by itself.

### The merge score

Not a model opinion — a deterministic function of published findings, with the votes shown
so the arithmetic is auditable.

```
base    = median(each model's self-reported merge confidence)
penalty = 2·P0 + 1·P1 + min(1, 0.5·P2)     (confirmed, published findings only)
score   = clamp(round(min(base, 5 - penalty)), 1, 5)
```

`min(base, 5 - penalty)` is the load-bearing part: models cannot vote away a confirmed
blocker, and a clean diff still can't reach 5 if the models were individually unsure.

---

## Cost accounting

The differentiator, and the thing that must never be wrong.

- **Never fabricate.** Every figure is labeled `reported` (provider-computed) or `estimated`
  (tokens × list price). A harness that returns neither prints **`unknown`**, and the total
  is marked as a lower bound. We do not guess.
- **Long-context tiers are cliffs, not slopes.** GPT-5.6 Sol reprices the *entire request* at
  2× input above 272k tokens; Grok 4.5 does the same above 200k. A flat per-token config
  silently underbills exactly the large-diff reviews that cost the most. When a harness only
  exposes aggregate multi-turn usage, Juror reports the standard-tier subtotal as a lower
  bound instead of guessing which individual requests crossed the cliff.
- **Cache writes are not free.** On GPT-5.6 and later they bill at 1.25× the uncached input
  rate. Anthropic bills them too. Juror models a review as write-once, read-many: the first
  model to see a diff pays the write premium, and re-reviews on later pushes get cheap.
- **Codex `input_tokens` includes cached tokens; Claude's and opencode's do not.** Normalizing
  naively overbills a cache-heavy Codex run by up to an order of magnitude. There is a
  regression test pinned to a real `turn.completed` payload for exactly this. A Codex turn
  can contain several provider requests, so its aggregate is never treated as one request
  when deciding whether a long-context price cliff applies.
- **Kimi K3 runs through Fireworks.** Kimi Code exposes token usage but not provider USD,
  so Juror multiplies those measured tokens by the versioned Fireworks list price and
  labels the row `estimated`.

`src/cost/pricing.json` is versioned, dated, and every entry carries a source URL.

`budget.target_cost_usd_per_pr` is deliberately a planning target, not a promise that every
provider can enforce a hard cap. Juror estimates only models whose keys are present and, in
`partial` mode, runs the subset estimated to fit. Claude also receives a native spend limit.
Actual usage can still cross the target on providers without that facility; the receipt and
review warnings report the overage instead of relabeling the estimate as a ceiling.

---

## Security

This is a bot that pipes attacker-controlled text into an agent and then writes to your PR.
It is designed for that.

1. **No model process ever sees `GITHUB_TOKEN`.** Every child environment is rebuilt from an
   allowlist with exactly one provider credential. Publishing starts only after all jurors exit.
   Prompt injection can at worst produce a bad review comment — never a push or merge.
2. **Default trigger is `pull_request`, not `pull_request_target`.** Fork PRs get no secrets
   and no review, by design.
3. **The repository is read-only to every juror.** Codex uses a kernel-enforced split
   filesystem profile that exposes only runtime files, the sealed checkout, and Juror scratch;
   its model-controlled shells inherit no process environment or shell snapshot, so the
   provider credential remains available to the Codex client but not to commands it runs.
   Claude, DeepSeek, Grok Build, opencode, and Kimi receive read/search tools only. Generic OpenAI
   resolves symlinks and may write only one exact report path outside the repository. Claude,
   Codex, and Kimi start from private temporary directories so PR-controlled hooks, MCP,
   settings, and `AGENTS.md` are not auto-loaded. Every run reads a detached checkout that
   excludes untracked operator files such as `.env`; after trusted base policy is loaded,
   Juror also removes the worktree's pointer back to credential-bearing git metadata. A
   workspace guard remains as defense in depth for direct library callers.
4. **Keys are passed per harness**, never to all of them. Each model process gets an
   environment containing only its own provider key.
5. **Injection is a finding.** Each model is told the diff is untrusted data and to report
   embedded instructions as a P0. Several independent models make a uniform injection
   substantially harder.
6. **Repository rules come from the base revision.** Juror places the root `AGENTS.md` and
   every applicable nested `AGENTS.md` directly in reviewer and verifier prompts. A PR can
   update those files for future work, but cannot rewrite the policy used to review itself.
   If the base object is unavailable locally, Juror warns and refuses to treat any workspace
   copy as policy; use a full checkout (`fetch-depth: 0`) so the trusted rules can be loaded.
   A blobless partial clone (`filter: blob:none`) keeps every ref and therefore works too,
   and is much faster to fetch on a large repository.
   The GitHub PR title and description are also included as explicitly untrusted intent
   context, so reviewers can recognize documented staged migrations without treating author
   claims as proof or executable instructions.
7. **Execution configuration also comes from the base revision.** A pull request cannot
   redirect a provider endpoint, select `GITHUB_TOKEN` as a model secret, or enable a new
   harness while it is being reviewed. If the base object is unavailable, secure defaults win.
8. **Everything posted is redacted** for secret-shaped strings first.

The complete [threat model](docs/threat-model.md) covers model subprocesses, installer scripts,
Action dependencies, token and provider-key boundaries, and residual risks. Please report a
suspected boundary escape through the private process in [`SECURITY.md`](SECURITY.md), not a
public issue.

External Actions are pinned to full commits and updated through Dependabot. Official releases
publish npm provenance plus GitHub build and SBOM attestations for the exact package and tagged
Action source archive; verification commands and the maintainer procedure are in the
[release guide](docs/releasing.md).

Juror does not emit product telemetry. The [privacy-preserving metrics contract](docs/metrics.md)
defines the default-off aggregate schema, retention and deletion requirements, explicit human
outcome labels, and a no-telemetry lighthouse measurement path that must precede any collector.

---

## Limitations

- Cost for Codex is **estimated**, not reported — the CLI exposes tokens but no dollar figure.
- Cost for Kimi Code is **estimated** from its private session usage records and the
  versioned Fireworks rate. If those records are unavailable, it falls back to `unknown`.
- Grok Build's headless JSON shape is parsed defensively and marked `unknown` when the fields
  aren't there, rather than guessed at.
- Agreement filtering needs ≥2 models to mean anything. With one key configured, the
  default all-findings mode still gives you a complete single-model review and an honest
  receipt, but there is no cross-model precision signal.
- Findings anchored outside the diff are surfaced in the summary but not posted inline,
  because GitHub can't attach them.
- The spend target is estimate-based for providers without native budget enforcement. Actual
  spend is always shown and can be slightly higher than the target.
- The 30-day rolling receipt is shown only when Juror has persistent local/self-hosted state;
  GitHub-hosted runners omit it instead of presenting a one-run ledger as a monthly total.

---

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js review --base main
```

Layout follows the pipeline: `src/diff` → `src/harness` → `src/merge` → `src/cost` →
`src/render` → `src/github`. `src/types.ts` is the only shared vocabulary.

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for model/preset, harness/provider, and
adjudicated benchmark paths. The generated [compatibility matrix](docs/compatibility.md) is
checked against the built-in configuration and pricing table in CI.

Maintainers should use the gated [post-proof launch playbook](docs/launch/README.md); it stays
no-go until representative benchmark and week-4 lighthouse evidence are complete.

Juror reviews its own pull requests. Every PR in this repo carries a public cost receipt.

## License

MIT.
