import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { releaseIdentityErrors } from '../scripts/verify-release.mjs';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function workflowFiles(): string[] {
  return [
    'action.yml',
    'qa/action.yml',
    ...readdirSync(join(root, '.github/workflows'))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => `.github/workflows/${name}`),
  ];
}

describe('supply-chain policy', () => {
  it('keeps the QA runtime dependencies and container bases exact', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
    };
    for (const name of ['@modelcontextprotocol/sdk', 'playwright', 'undici', 'zod']) {
      expect(packageJson.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }

    const dockerfile = read('qa/Dockerfile');
    const bases = [...dockerfile.matchAll(
      /^FROM mcr\.microsoft\.com\/playwright:v([^@\s]+)@sha256:([0-9a-f]{64})/gm,
    )];
    expect(bases).toHaveLength(2);
    expect(new Set(bases.map((match) => match[1]))).toEqual(
      new Set([`${packageJson.dependencies['playwright']}-noble`]),
    );
    expect(new Set(bases.map((match) => match[2]))).toHaveLength(1);
    expect(dockerfile).toMatch(/npm install -g @openai\/codex@\d+\.\d+\.\d+\s/);
  });

  it('installs Playwright Chromium before browser tests in every validation workflow', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/release-qa-image.yml',
    ]) {
      const workflow = read(path);
      const install = workflow.indexOf('playwright install --with-deps chromium');
      const tests = workflow.indexOf('npm test');
      expect(install, path).toBeGreaterThanOrEqual(0);
      expect(tests, path).toBeGreaterThan(install);
    }
  });

  it('registers arm64 emulation before the multi-platform QA image build', () => {
    const workflow = read('.github/workflows/release-qa-image.yml');
    const qemu = workflow.indexOf('docker/setup-qemu-action@');
    const buildx = workflow.indexOf('docker/setup-buildx-action@');
    const build = workflow.indexOf('docker/build-push-action@');

    expect(qemu).toBeGreaterThanOrEqual(0);
    expect(buildx).toBeGreaterThan(qemu);
    expect(build).toBeGreaterThan(buildx);
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('platforms: arm64');
    expect(workflow).toMatch(
      /image: docker\.io\/tonistiigi\/binfmt:[^\s@]+@sha256:[0-9a-f]{64}/,
    );
  });

  it('pins every external GitHub Action to an immutable revision with a version comment', () => {
    const mutable: string[] = [];

    for (const path of workflowFiles()) {
      for (const [index, line] of read(path).split('\n').entries()) {
        const match = line.match(/\buses:\s*([^\s#]+)@([^\s#]+)/);
        if (!match || match[1]?.startsWith('./')) continue;

        const ref = match[2] ?? '';
        if (!/^[0-9a-f]{40}$/.test(ref) || !/#\s*v?\d/.test(line)) {
          mutable.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(mutable, mutable.join('\n')).toEqual([]);
  });

  it('keeps public Juror installation examples immutable', () => {
    const mutable = [...read('README.md').matchAll(/juror-ai\/juror@([^\s#]+)/g)]
      .map((match) => match[1] ?? '')
      .filter((ref) => !/^[0-9a-f]{40}$/.test(ref));

    expect(mutable).toEqual([]);
  });

  it('configures Dependabot for npm and pinned GitHub Action revisions', () => {
    const config = read('.github/dependabot.yml');

    expect(config).toContain('package-ecosystem: npm');
    expect(config).toContain('package-ecosystem: github-actions');
  });

  it('keeps OpenRouter and Scaleway keys away from setup, cache, build, and installer steps', () => {
    const action = parse(read('action.yml')) as {
      runs: { steps: { name?: string; env?: Record<string, string> }[] };
    };
    const reviewIndex = action.runs.steps.findIndex((step) => step.name === 'Review');

    expect(reviewIndex).toBeGreaterThan(0);
    for (const step of action.runs.steps.slice(0, reviewIndex)) {
      expect(step.env?.['JUROR_OPENROUTER_API_KEY'], step.name).toBe('');
      expect(step.env?.['OPENROUTER_API_KEY'], step.name).toBe('');
      expect(step.env?.['JUROR_SCALEWAY_API_KEY'], step.name).toBe('');
      expect(step.env?.['SCW_SECRET_KEY'], step.name).toBe('');
    }
  });

  it('verifies the released QA image before injecting QA credentials', () => {
    const action = parse(read('qa/action.yml')) as {
      inputs: Record<string, unknown>;
      runs: { steps: { name?: string; env?: Record<string, string>; run?: string; uses?: string }[] };
    };
    const steps = action.runs.steps;
    const verifyIndex = steps.findIndex((step) => step.name === 'Resolve and verify the released QA image');
    const policyIndex = steps.findIndex((step) => step.name === 'Read trusted QA policy before credential handoff');
    const browserIndex = steps.findIndex((step) => step.name === 'Verify container-isolated Chromium on the QA runner');
    const qaIndex = steps.findIndex((step) => step.name === 'Run Juror QA in the verified image');
    const qaRun = steps[qaIndex]?.run ?? '';
    const qaRuntimeCreate = qaRun.slice(qaRun.indexOf('docker create'), qaRun.indexOf('STATUS=$?'));

    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(qaIndex).toBeGreaterThan(verifyIndex);
    expect(policyIndex).toBeGreaterThan(verifyIndex);
    expect(browserIndex).toBeGreaterThan(policyIndex);
    expect(qaIndex).toBeGreaterThan(policyIndex);
    expect(qaIndex).toBeGreaterThan(browserIndex);
    expect(action.inputs).not.toHaveProperty('codex-version');
    expect(action.inputs).not.toHaveProperty('allow-origins');
    expect(steps.some((step) => step.uses?.startsWith('actions/cache@'))).toBe(false);
    expect(steps.slice(0, qaIndex).some((step) => /npm ci|playwright install/.test(step.run ?? ''))).toBe(false);
    expect(steps[verifyIndex]?.env?.['JUROR_OPENAI_API_KEY']).toBe('');
    expect(steps[verifyIndex]?.env?.['JUROR_QA_SECRETS_B64']).toBe('');
    expect(steps[verifyIndex]?.run).toContain('gh attestation verify');
    expect(steps[verifyIndex]?.run).toContain('--bundle-from-oci');
    expect(steps[verifyIndex]?.run).toContain('--source-digest');
    expect(steps[policyIndex]?.env?.['JUROR_OPENAI_API_KEY']).toBe('');
    expect(steps[policyIndex]?.env?.['JUROR_QA_SECRETS_B64']).toBe('');
    expect(steps[policyIndex]?.run).toContain('POLICY_NAME="juror-qa-policy-$POLICY_SUFFIX"');
    expect(steps[policyIndex]?.run).toContain('docker create');
    expect(steps[policyIndex]?.run).toContain('--name "$POLICY_NAME"');
    const policyCreate = steps[policyIndex]?.run?.slice(
      steps[policyIndex]?.run?.indexOf('docker create'),
      steps[policyIndex]?.run?.indexOf('docker start'),
    ) ?? '';
    expect(policyCreate).toContain('--init');
    expect(steps[policyIndex]?.run).toContain('docker start --attach "$POLICY_NAME"');
    expect(steps[policyIndex]?.run).toContain('docker rm -f "$POLICY_NAME"');
    expect(steps[policyIndex]?.run).toContain("trap 'cancel_policy_container TERM' TERM");
    expect(steps[qaIndex]?.run).toContain('--pull=never');
    expect(steps[qaIndex]?.run?.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(steps[qaIndex]?.run).toContain('"$EXACT_IMAGE"');
    expect(steps[qaIndex]?.run).toContain('docker network create --internal');
    expect(steps[qaIndex]?.run).toContain('proxy-url.mjs');
    expect(steps[qaIndex]?.run).toContain('JUROR_QA_BROWSER_PROXY=$PROXY_URL');
    expect(steps[qaIndex]?.run).not.toContain('--alias juror-qa-proxy');
    expect(steps[qaIndex]?.run).toContain('/opt/juror/qa/egress-proxy.mjs');
    expect(steps[qaIndex]?.run).toContain('runtime_status: null');
    expect(steps[qaIndex]?.run).toContain('payload-status.json');
    expect(steps[qaIndex]?.env?.['POLICY_RETENTION']).toBe('${{ steps.policy.outputs.retention-days }}');
    expect(steps[qaIndex]?.run).toContain('configuredRetention ?? fallbackRetention');
    expect(steps[policyIndex]?.run).not.toContain('--allow-origin');
    expect(steps[qaIndex]?.run).not.toContain('--allow-origin');
    expect(steps[browserIndex]?.if).toBe("steps.policy.outputs.enabled == 'true'");
    expect(steps[browserIndex]?.env?.['JUROR_OPENAI_API_KEY']).toBe('');
    expect(steps[browserIndex]?.env?.['JUROR_QA_SECRETS_B64']).toBe('');
    expect(steps[browserIndex]?.run).toContain('/opt/juror/qa/smoke-chromium.mjs');
    expect(steps[browserIndex]?.run).toContain('--network none');
    expect(steps[browserIndex]?.run).toContain('--user "$RUNTIME_USER"');
    expect(steps[browserIndex]?.run).toContain('seccomp=$GITHUB_ACTION_PATH/seccomp_profile.json');
    expect(steps[browserIndex]?.run).toContain('--security-opt no-new-privileges');
    expect(steps[browserIndex]?.run).not.toContain('--cap-add=SYS_CHROOT');
    expect(steps[browserIndex]?.run).not.toContain('apparmor=unconfined');
    expect(qaRuntimeCreate).toContain('--security-opt no-new-privileges');
    expect(qaRuntimeCreate).not.toContain('--cap-add=SYS_CHROOT');
    expect(qaRuntimeCreate).not.toContain('apparmor=unconfined');
  });

  it('uploads immutable payload and result artifacts around finalization', () => {
    const action = parse(read('qa/action.yml')) as {
      outputs: Record<string, { value?: string }>;
      runs: {
        steps: {
          name?: string;
          id?: string;
          env?: Record<string, string>;
          run?: string;
          with?: Record<string, unknown>;
          if?: string;
          'continue-on-error'?: boolean;
        }[];
      };
    };
    const steps = action.runs.steps;
    const qa = steps.findIndex((step) => step.name === 'Run Juror QA in the verified image');
    const stage = steps.findIndex((step) => step.name === 'Stage validated QA evidence payload');
    const upload = steps.findIndex((step) => step.name === 'Upload QA evidence payload');
    const publication = steps.findIndex((step) => step.name === 'Finalize and publish QA result');
    const resultUpload = steps.findIndex((step) => step.name === 'Upload finalized QA report');
    const finalize = steps.findIndex((step) => step.name === 'Reconcile final QA outcome');
    const conclusion = steps.findIndex((step) => step.name === 'Apply QA conclusion');
    const finalizeRun = steps[finalize]?.run ?? '';

    expect(qa).toBeGreaterThanOrEqual(0);
    expect(stage).toBeGreaterThan(qa);
    expect(upload).toBeGreaterThan(qa);
    expect(upload).toBeGreaterThan(stage);
    expect(publication).toBeGreaterThan(upload);
    expect(resultUpload).toBeGreaterThan(publication);
    expect(finalize).toBeGreaterThan(resultUpload);
    expect(conclusion).toBeGreaterThan(finalize);
    expect(steps[qa]?.run).not.toContain('ARGS+=(--post)');
    expect(steps[stage]?.['continue-on-error']).toBe(true);
    expect(steps[stage]?.run).toContain('stage-evidence.mjs');
    expect(steps[upload]?.['continue-on-error']).toBe(true);
    expect(steps[upload]?.if).toContain("steps.stage_evidence.outcome == 'success'");
    expect(steps[upload]?.with?.['if-no-files-found']).toBe('error');
    expect(steps[upload]?.with?.['name']).toContain('${{ github.run_attempt }}');
    expect(steps[upload]?.with?.['path']).toBe('${{ steps.stage_evidence.outputs.path }}');
    expect(steps[upload]?.with?.['path']).not.toContain('/report.json');
    expect(steps[upload]?.with?.['path']).not.toContain('/summary.md');
    expect(steps[publication]?.env?.['UPLOAD_OUTCOME']).toBe('${{ steps.evidence.outcome }}');
    expect(steps[publication]?.run).toContain('/opt/juror/dist/cli.js "${ARGS[@]}"');
    expect(steps[publication]?.run).toContain('JUROR_QA_ACTION_FINALIZATION_ERROR="$FINALIZATION_ERROR"');
    expect(steps[publication]?.run).toContain('GITHUB_OUTPUT="$GITHUB_OUTPUT"');
    expect(steps[publication]?.run).toContain('JUROR_QA_ACTION_READ_ONLY=false');
    expect(steps[publication]?.run).toContain('JUROR_QA_ACTION_REQUIRE_INFRASTRUCTURE_ERROR=false');
    expect(steps[publication]?.run).toContain('if [ "$INPUT_POST" = "true" ]; then ARGS+=(--post-pending); fi');
    expect(steps[publication]?.run).toContain('qa-publish-final');
    expect(steps[publication]?.run).toContain('PUBLISH_ARGS+=(--artifact-url "$ARTIFACT_URL")');
    expect(steps[publication]?.run?.match(/--env JUROR_QA_SECRETS_B64/g)).toHaveLength(2);
    expect(steps[publication]?.run).not.toContain('--env JUROR_QA_SECRETS_B64=');
    expect(steps[resultUpload]?.['continue-on-error']).toBe(true);
    expect(steps[resultUpload]?.with?.['if-no-files-found']).toBe('error');
    expect(steps[resultUpload]?.with?.['name']).toContain('${{ github.run_attempt }}');
    expect(steps[resultUpload]?.with?.['path']).toContain('/report.json');
    expect(steps[resultUpload]?.with?.['path']).toContain('/summary.md');
    expect(steps[resultUpload]?.with?.['path']).not.toContain('/scenarios/');
    expect(steps[finalize]?.env?.['RESULT_UPLOAD_OUTCOME']).toBe('${{ steps.result_evidence.outcome }}');
    expect(steps[finalize]?.run).toContain('if [ "$RESULT_UPLOAD_OUTCOME" = "success" ]; then');
    expect(steps[finalize]?.run).not.toContain('RESULT_ARTIFACT_URL');
    expect(steps[publication]?.run).toContain('--artifact-upload-error');
    expect(steps[finalize]?.run).toContain('--finalization-error');
    expect(steps[finalize]?.run).toContain('echo "outcome=$PUBLICATION_OUTCOME"');
    expect(steps[finalize]?.run).toContain('existing comment remains non-final');
    expect(steps[finalize]?.run).toContain('qa-publish-final');
    expect(steps[finalize]?.run).toContain('ARGS+=(--artifact-name "$ARTIFACT_NAME" --artifact-url "$ARTIFACT_URL")');
    expect(steps[finalize]?.run?.match(/--env JUROR_QA_SECRETS_B64/g)).toHaveLength(2);
    expect(steps[finalize]?.run).not.toContain('--env JUROR_QA_SECRETS_B64=');
    expect(steps[finalize]?.run).toContain('JUROR_QA_ACTION_READ_ONLY=false');
    expect(steps[finalize]?.run).toContain('GITHUB_OUTPUT="$GITHUB_OUTPUT"');
    expect(steps[finalize]?.run).toContain('JUROR_QA_ACTION_REQUIRE_INFRASTRUCTURE_ERROR=true');
    expect(steps[finalize]?.env?.['SUMMARY_PATH']).toContain('steps.runtime.outputs.summary-path');
    expect(steps[finalize]?.run).toContain('cat "$SUMMARY_PATH" >> "$GITHUB_STEP_SUMMARY"');
    expect(steps[finalize]?.run).not.toMatch(/jq[^\n]*REPORT_PATH[^\n]*GITHUB_STEP_SUMMARY/);
    expect(finalizeRun.indexOf('cat "$SUMMARY_PATH" >> "$GITHUB_STEP_SUMMARY"'))
      .toBeLessThan(finalizeRun.indexOf('The PR comment could not be finalized'));
    expect(action.outputs['outcome']?.value).toContain('steps.finalize.outputs.outcome');
  });

  it('publishes setup failures only through a verified image and preserves normal finalization', () => {
    const action = parse(read('qa/action.yml')) as {
      outputs: Record<string, { value?: string }>;
      runs: { steps: { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> }[] };
    };
    const steps = action.runs.steps;
    const image = steps.findIndex((step) => step.id === 'image');
    const runtime = steps.findIndex((step) => step.id === 'runtime');
    const policy = steps.findIndex((step) => step.id === 'policy');
    const browser = steps.findIndex((step) => step.id === 'browser');
    const preflight = steps.findIndex((step) => step.name === 'Publish QA setup failure');
    const disabled = steps.findIndex((step) => step.name === 'Record disabled QA outcome');
    const conclusion = steps.findIndex((step) => step.name === 'Apply QA conclusion');
    const setup = steps[preflight];

    expect(preflight).toBe(browser + 1);
    expect(preflight).toBeGreaterThan(image);
    expect(preflight).toBeGreaterThan(runtime);
    expect(setup?.if).toContain("steps.browser.outcome == 'failure'");
    expect(setup?.env?.['JUROR_QA_PREFLIGHT_PHASE']).toContain("steps.image.outcome == 'failure'");
    for (const key of [
      'JUROR_OPENAI_API_KEY', 'OPENAI_API_KEY', 'JUROR_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY',
      'JUROR_XAI_API_KEY', 'XAI_API_KEY', 'JUROR_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY',
      'JUROR_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'JUROR_QA_SECRETS_B64', 'CODEX_HOME',
    ]) expect(setup?.env?.[key], key).toBe('');
    expect(setup?.run).toContain('JUROR_QA_PREFLIGHT_MODE=true');
    expect(setup?.run).toContain('qa-publish-final');
    expect(setup?.run).toContain('[ "$IMAGE_VERIFIED" = \'true\' ]');
    expect(setup?.run).toContain('[ "$RUNTIME_PREPARED" = \'true\' ]');
    expect(setup?.run).toContain('if [ "$WRITE_REPORT" = \'true\' ] && [ "$INPUT_POST" = \'true\' ]; then');
    expect(setup?.run).toContain('"$EXACT_IMAGE"');
    expect(setup?.run).not.toContain('curl');
    expect(setup?.run).not.toContain('gh api');
    expect(steps[disabled]?.if).toBe("steps.policy.outcome == 'success' && steps.policy.outputs.enabled == 'false'");
    expect(action.outputs['outcome']?.value).toContain('steps.preflight.outputs.outcome');
    expect(steps[conclusion]?.env?.['EXIT_CODE']).toContain('steps.preflight.outputs.exit-code');
    const result = steps.find((step) => step.name === 'Upload finalized QA report');
    expect(result?.with?.['path']).toContain('/report.json');
    expect(result?.with?.['path']).toContain('/summary.md');
  });

  it('runs both workspace-reading containers as the numeric host user', () => {
    const action = parse(read('qa/action.yml')) as {
      runs: { steps: { name?: string; env?: Record<string, string>; run?: string }[] };
    };
    const prepare = action.runs.steps.find(
      (step) => step.name === 'Prepare isolated QA runtime',
    );
    const policy = action.runs.steps.find(
      (step) => step.name === 'Read trusted QA policy before credential handoff',
    );
    const qa = action.runs.steps.find(
      (step) => step.name === 'Run Juror QA in the verified image',
    );
    const qaRun = qa?.run ?? '';
    const policyRun = policy?.run ?? '';
    const policyCreate = policyRun.slice(
      policyRun.indexOf('docker create'),
      policyRun.indexOf('docker start'),
    );
    const proxyCreate = qaRun.slice(
      qaRun.indexOf('docker run --detach'),
      qaRun.indexOf('docker network connect'),
    );
    const runtimeCreate = qaRun.slice(
      qaRun.lastIndexOf('docker create'),
      qaRun.indexOf('STATUS=$?'),
    );

    expect(prepare?.run).toContain('RUNNER_UID="$(id -u)"');
    expect(prepare?.run).toContain('RUNNER_GID="$(id -g)"');
    expect(prepare?.run).toContain('runtime-user=$RUNTIME_USER');
    expect(policy?.env?.['RUNTIME_USER']).toBe('${{ steps.runtime.outputs.runtime-user }}');
    expect(policyRun).toContain('if ! [[ "$RUNTIME_USER" =~ ^[0-9]+:[0-9]+$ ]]');
    expect(policyCreate).toContain('--user "$RUNTIME_USER"');
    expect(policyCreate).not.toContain('--user pwuser');
    expect(policyRun).not.toContain('safe.directory');
    expect(qa?.env?.['RUNTIME_USER']).toBe('${{ steps.runtime.outputs.runtime-user }}');
    expect(qaRun).toContain('if ! [[ "$RUNTIME_USER" =~ ^[0-9]+:[0-9]+$ ]]');
    expect(qaRun.match(/--user "\$RUNTIME_USER"/g)).toHaveLength(1);
    expect(runtimeCreate).toContain('--user "$RUNTIME_USER"');
    expect(runtimeCreate).not.toContain('--user pwuser');
    expect(policyCreate).toContain('type=bind,src=$GITHUB_WORKSPACE,dst=/workspace,readonly');
    expect(qaRun).toContain('type=bind,src=$GITHUB_WORKSPACE,dst=/workspace,readonly');
    expect(proxyCreate).toContain('--user pwuser');
    expect(proxyCreate).not.toContain('$RUNTIME_USER');
  });

  it('validates UID and GID before writing the runtime-user step output', () => {
    const action = parse(read('qa/action.yml')) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const prepare = action.runs.steps.find(
      (step) => step.name === 'Prepare isolated QA runtime',
    )?.run ?? '';
    const scratch = mkdtempSync(join(tmpdir(), 'juror-action-runtime-user-'));
    try {
      const fakeBin = join(scratch, 'bin');
      const runnerTemp = join(scratch, 'runner');
      const output = join(scratch, 'github-output');
      mkdirSync(fakeBin);
      mkdirSync(runnerTemp);
      const idPath = join(fakeBin, 'id');
      const runPrepare = () => spawnSync('bash', ['-c', prepare], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
          INPUT_PR: '42',
          EVENT_PR: '',
          INPUT_STORAGE_STATE: '',
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: output,
        },
      });

      writeFileSync(idPath, `#!/usr/bin/env bash
case "\${1:-}" in
  -u) echo 1234 ;;
  -g) echo 5678 ;;
  *) exit 2 ;;
esac
`);
      chmodSync(idPath, 0o755);
      writeFileSync(output, '');
      const valid = runPrepare();
      expect(valid.status, valid.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('runtime-user=1234:5678\n');

      writeFileSync(idPath, `#!/usr/bin/env bash
case "\${1:-}" in
  -u) printf '1234\\ninjected=true\\n' ;;
  -g) echo 5678 ;;
  *) exit 2 ;;
esac
`);
      writeFileSync(output, '');
      const injected = runPrepare();
      expect(injected.status).not.toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('stops the named QA runtime before dismantling its egress path on cancellation', () => {
    const action = parse(read('qa/action.yml')) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const runtime = action.runs.steps.find(
      (step) => step.name === 'Run Juror QA in the verified image',
    )?.run ?? '';
    const cleanup = runtime.slice(
      runtime.indexOf('cleanup_runtime()'),
      runtime.indexOf('cancel_runtime()'),
    );

    expect(runtime).toContain('RUNTIME_NAME="juror-qa-runtime-$SUFFIX"');
    expect(runtime).toContain('docker create \\\n  --name "$RUNTIME_NAME"');
    expect(runtime).toContain('docker start --attach "$RUNTIME_NAME" &');
    expect(runtime).toContain('wait "$RUNTIME_ATTACH_PID"');
    expect(runtime).toContain("trap 'cancel_runtime INT' INT");
    expect(runtime).toContain("trap 'cancel_runtime TERM' TERM");
    expect(runtime).toContain('INT) exit 130');
    expect(runtime).toContain('TERM) exit 143');
    expect(cleanup).toContain('local status=$?');
    expect(cleanup).toContain('exit "$status"');
    expect(cleanup).toContain("trap '' INT TERM");
    const stopGrace = cleanup.match(/docker stop --time (\d+) "\$RUNTIME_NAME"/);
    expect(stopGrace).not.toBeNull();
    expect(Number(stopGrace?.[1])).toBeLessThan(7.5);
    expect(cleanup.indexOf('docker stop --time 5 "$RUNTIME_NAME"')).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf('docker rm -f "$RUNTIME_NAME"')).toBeGreaterThan(
      cleanup.indexOf('docker stop --time 5 "$RUNTIME_NAME"'),
    );
    expect(cleanup.indexOf('docker rm -f "$PROXY_NAME"')).toBeGreaterThan(
      cleanup.indexOf('docker rm -f "$RUNTIME_NAME"'),
    );
    expect(cleanup.indexOf('docker network rm "$INTERNAL_NETWORK"')).toBeGreaterThan(
      cleanup.indexOf('docker rm -f "$PROXY_NAME"'),
    );
  });

  it('ships container-isolated Chromium and an exact-origin egress boundary', () => {
    const dockerfile = read('qa/Dockerfile');
    const action = read('qa/action.yml');
    const localRunner = read('qa/run-local.sh');
    const imageCi = read('.github/workflows/qa-image-ci.yml');
    const releaseWorkflow = read('.github/workflows/release-qa-image.yml');
    const browser = read('src/qa/browser.ts');
    const proxy = read('qa/egress-proxy.mjs');
    const proxyUrl = read('qa/proxy-url.mjs');

    expect(action).toContain('seccomp=$GITHUB_ACTION_PATH/seccomp_profile.json');
    expect(action).toContain('--cap-drop=ALL');
    expect(action).not.toContain('--cap-add=SYS_CHROOT');
    expect(action).not.toContain('apparmor=unconfined');
    expect(dockerfile).toContain('HOME=/home/pwuser');
    expect(action.match(/uid=\$RUNTIME_UID,gid=\$RUNTIME_GID,mode=0700/g)).toHaveLength(3);
    expect(localRunner.match(/uid=\$CONTAINER_UID,gid=\$CONTAINER_GID,mode=0700/g)).toHaveLength(2);
    expect(releaseWorkflow).toContain('PW_UID="$(docker run --rm --entrypoint id "$EXACT_IMAGE" -u pwuser)"');
    expect(releaseWorkflow).toContain('uid=$PW_UID,gid=$PW_GID,mode=0700');
    expect(releaseWorkflow).toContain('--user "$PW_UID:$PW_GID"');
    expect(releaseWorkflow).not.toContain('uid=1001,gid=1001');
    expect(dockerfile).toContain('qa/smoke-chromium.mjs');
    expect(imageCi).toContain('/opt/juror/qa/smoke-chromium.mjs');
    expect(imageCi).toContain('run_chromium_smoke "$ARBITRARY_UID" "$ARBITRARY_GID"');
    expect(releaseWorkflow).toContain('/opt/juror/qa/smoke-chromium.mjs');
    expect(read('qa/seccomp_profile.json')).not.toContain('Allow create user namespaces');
    expect(browser).toContain('chromiumSandbox = false');
    expect(browser).toContain('this.#options.chromiumSandbox ?? false');
    expect(browser).toContain("channel: 'chromium'");
    expect(proxy).toContain('const allowed = new Set');
    expect(proxy).toContain("server.on('connect'");
    expect(proxy).toContain('private address denied');
    expect(proxyUrl).toContain('net.isIP(address) !== 4');
    expect(action).toContain('node "$GITHUB_ACTION_PATH/proxy-url.mjs"');
    expect(localRunner).toContain('node "$ROOT/qa/proxy-url.mjs"');
    expect(action).not.toContain('--alias juror-qa-proxy');
    expect(localRunner).not.toContain('--alias juror-qa-proxy');
    expect(action).toContain('--env "JUROR_QA_BROWSER_PROXY=$PROXY_URL"');
    expect(localRunner).toContain('--env "JUROR_QA_BROWSER_PROXY=$PROXY_URL"');
  });

  it('runs native QA image CI for every Docker build input', () => {
    const workflow = parse(read('.github/workflows/qa-image-ci.yml')) as {
      on: {
        push: { paths: string[] };
        pull_request: { paths: string[] };
      };
    };

    for (const event of [workflow.on.push, workflow.on.pull_request]) {
      expect(event.paths).toEqual(expect.arrayContaining([
        '.dockerignore',
        'qa/**',
        'scripts/**',
        'src/**',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
      ]));
    }
  });

  it('never embeds locally discovered credentials in Docker argv', () => {
    const runner = read('qa/run-local.sh');

    expect(runner).toContain('export GITHUB_TOKEN="$QA_GITHUB_TOKEN"');
    expect(runner).toContain('TOKEN_ARGS+=(--env GITHUB_TOKEN)');
    expect(runner).toContain('ENV_ARGS+=(--env GITHUB_TOKEN)');
    expect(runner).not.toMatch(/--env\s+["']?GITHUB_TOKEN=/);
    expect(runner).not.toMatch(/--env\s+["']?(?:JUROR_OPENAI_API_KEY|OPENAI_API_KEY|JUROR_QA_SECRETS_B64)=\$/);
  });

  it('uses only supported Codex feature flags for the private QA profile', () => {
    const agent = read('src/qa/agent.ts');

    expect(agent).toContain('browser_use = false');
    expect(agent).toContain('browser_use_external = false');
    expect(agent).toContain('in_app_browser = false');
    expect(agent).not.toContain('browser_use_full_cdp_access');
  });

  it('leaves missing-object hydration to the isolated runtime broker', () => {
    const runner = read('qa/run-local.sh');
    const cli = read('src/cli.ts');

    expect(cli).toContain('merge_sha: resolved.mergeSha');
    expect(cli).toContain('promisor: githubPromisorAccess(repo, token)');
    expect(runner).not.toContain('materialize-commit.sh');
    expect(runner).not.toContain('git fetch');
  });

  it('defers merged diff materialization until trusted QA policy opts in', () => {
    const cli = read('src/cli.ts');
    const policyStart = cli.indexOf('async function runQaPolicyCommand');
    const runtimeStart = cli.indexOf('async function runQaCommand');
    const benchmarkStart = cli.indexOf('async function runBenchmarkCommand');
    const policy = cli.slice(policyStart, runtimeStart);
    const runtime = cli.slice(runtimeStart, benchmarkStart);

    expect(policy).toContain('const resolved = await resolveMergedPull(client, pull)');
    expect(policy).not.toContain('.diffFrom(');
    expect(policy).toContain('loadQaConfigConsensusFromBases');
    expect(runtime.indexOf('if (!qaConfig.enabled)')).toBeGreaterThanOrEqual(0);
    expect(runtime.indexOf('loadQaConfigConsensusFromBases'))
      .toBeLessThan(runtime.indexOf('if (!qaConfig.enabled)'));
    expect(runtime).toContain('const termination = qaTerminationController()');
    expect(cli.indexOf("process.once('SIGINT', onSigint)"))
      .toBeLessThan(cli.indexOf('async function runQaCommand'));
    expect(runtime).toContain('signal: controller.signal');
    expect(runtime.indexOf('preparedCheckout.diffFrom(resolved.sourceBaseSha'))
      .toBeGreaterThan(runtime.indexOf('if (!qaConfig.enabled)'));
    expect(runtime).toContain('preparedCheckout.changedPathsFrom(');
    expect(runtime).toContain('changedFiles,');
    expect(runtime).toContain('refusing to plan from an incomplete affected-file list');
  });

  it('fails closed when GitHub omits or changes either pull-request repository identity', () => {
    const cli = read('src/cli.ts');
    const start = cli.indexOf('function assertQaPullRepository');
    const end = cli.indexOf('\n}', start) + 2;
    const guard = cli.slice(start, end);

    expect(guard).toContain('!base || !head');
    expect(guard).toContain('base !== expected || head !== expected');
    expect(cli.match(/assertQaPullRepository\(pull, repo\)/g)).toHaveLength(2);
  });

  it('owns and removes both local credential-bearing containers on interruption', () => {
    const runner = read('qa/run-local.sh');

    expect(runner).toContain('POLICY_NAME="juror-qa-policy-$SUFFIX"');
    expect(runner).toContain('RUNTIME_NAME="juror-qa-runtime-$SUFFIX"');
    expect(runner).toContain('--name "$POLICY_NAME"');
    expect(runner).toContain('--name "$RUNTIME_NAME"');
    const policyCreate = runner.slice(runner.indexOf('docker create'), runner.indexOf('docker start'));
    const runtimeCreate = runner.slice(runner.lastIndexOf('docker create'), runner.lastIndexOf('docker start'));
    expect(policyCreate).toContain('--init');
    expect(runtimeCreate).toContain('--init');
    expect(runner).toContain('docker start --attach "$POLICY_NAME"');
    expect(runner).toContain('docker start --attach "$RUNTIME_NAME"');
    expect(runner).toContain('docker rm -f "$POLICY_NAME"');
    expect(runner).toContain('docker rm -f "$RUNTIME_NAME"');
    expect(runner).toContain("trap 'cancel_all INT' INT");
    expect(runner).toContain("trap 'cancel_all TERM' TERM");
  });

  it('forwards the GitHub API base to both trusted-policy and runtime containers', () => {
    const action = parse(read('qa/action.yml')) as {
      runs: { steps: { name?: string; env?: Record<string, string>; run?: string }[] };
    };
    const policy = action.runs.steps.find(
      (step) => step.name === 'Read trusted QA policy before credential handoff',
    );
    const runtime = action.runs.steps.find(
      (step) => step.name === 'Run Juror QA in the verified image',
    );
    expect(policy?.env?.['GITHUB_API_URL']).toBe('${{ github.api_url }}');
    expect(policy?.env?.['GITHUB_SERVER_URL']).toBe('${{ github.server_url }}');
    expect(policy?.run).toContain('--env GITHUB_API_URL');
    expect(policy?.run).toContain('--env GITHUB_SERVER_URL');
    expect(runtime?.env?.['GITHUB_API_URL']).toBe('${{ github.api_url }}');
    expect(runtime?.run).toContain('--env GITHUB_API_URL');

    const runner = read('qa/run-local.sh');
    const policyBlock = runner.slice(0, runner.indexOf('if [ "$(jq -r'));
    const runtimeBlock = runner.slice(runner.indexOf('ENV_ARGS=()'));
    expect(policyBlock).toContain('for NAME in GITHUB_API_URL GITHUB_SERVER_URL');
    expect(runtimeBlock).toContain('GITHUB_TOKEN GH_TOKEN GITHUB_API_URL GITHUB_SERVER_URL');
  });

  it('uploads only the fail-closed staged report-ledger directory', () => {
    const action = parse(read('qa/action.yml')) as {
      runs: {
        steps: {
          name?: string;
          env?: Record<string, string>;
          run?: string;
          with?: Record<string, string>;
        }[];
      };
    };
    const stage = action.runs.steps.find(
      (step) => step.name === 'Stage validated QA evidence payload',
    );
    const upload = action.runs.steps.find((step) => step.name === 'Upload QA evidence payload');
    const paths = upload?.with?.['path'] ?? '';

    expect(stage?.run).toContain('node "$GITHUB_ACTION_PATH/stage-evidence.mjs"');
    expect(stage?.run).toContain('"$EVIDENCE_DIR" "$STAGED_PAYLOAD_DIR"');
    expect(paths).toBe('${{ steps.stage_evidence.outputs.path }}');
    expect(paths).not.toContain('steps.runtime.outputs.evidence-dir');
    expect(paths).not.toContain('/report.json');
    expect(paths).not.toContain('/summary.md');
    expect(paths).not.toContain('/payload-status.json');
  });

  it('never loads arbitrary environment variables from the tested repository for QA', () => {
    const cli = read('src/cli.ts');
    const qaCommand = cli.slice(cli.indexOf('async function runQaCommand'), cli.indexOf('async function runBenchmarkCommand'));

    expect(qaCommand).toContain('loadQaEnvFile(args.envFile, repoDir)');
    expect(qaCommand).not.toContain("path.join(repoDir, '.env')");
    expect(cli).toContain("'JUROR_QA_SECRETS_B64'");
    expect(cli).toContain('QA refuses to load an environment file from the tested repository');
    const qaEnvKeys = cli.slice(cli.indexOf('const QA_ENV_FILE_KEYS'), cli.indexOf(']);', cli.indexOf('const QA_ENV_FILE_KEYS')) + 3);
    expect(qaEnvKeys).not.toContain('GIT_CONFIG');
  });

  it('rejects a repository-owned QA environment symlink before credential loading', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-cli-env-symlink-'));
    try {
      const repository = join(scratch, 'repository');
      const outsideFile = join(scratch, 'operator.env');
      const repositoryLink = join(repository, 'credentials.env');
      const repositoryAlias = join(scratch, 'repository-alias');
      const operatorDirectory = join(scratch, 'operator-directory');
      const escapeDirectory = join(repository, 'escape');
      const aliasedTraversal = join(repositoryAlias, 'escape', 'operator.env');
      mkdirSync(repository);
      mkdirSync(operatorDirectory);
      const initialized = spawnSync('git', ['init', '-q', '-b', 'main'], {
        cwd: repository,
        encoding: 'utf8',
      });
      expect(initialized.status, initialized.stderr).toBe(0);
      writeFileSync(outsideFile, 'OPENAI_API_KEY=outside\n');
      writeFileSync(join(operatorDirectory, 'operator.env'), 'OPENAI_API_KEY=outside\n');
      symlinkSync(outsideFile, repositoryLink);
      symlinkSync(repository, repositoryAlias, 'dir');
      symlinkSync(operatorDirectory, escapeDirectory, 'dir');

      for (const candidate of [repositoryLink, aliasedTraversal]) {
        const result = spawnSync(
          join(root, 'node_modules', '.bin', 'vite-node'),
          [
            join(root, 'src/cli.ts'),
            'qa',
            '--pr',
            '1',
            '--repo',
            'owner/example',
            '--repo-dir',
            repository,
            '--env-file',
            candidate,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              PATH: process.env['PATH'],
              HOME: process.env['HOME'],
              NO_COLOR: '1',
            },
          },
        );

        expect(result.status, `${candidate}\n${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(
          'QA refuses to load an environment file from the tested repository',
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('mounts an external QA environment file into the trusted runtime only', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-run-local-env-'));
    try {
      const fakeBin = join(scratch, 'bin');
      const evidenceDir = join(scratch, 'evidence');
      const envFile = join(scratch, 'credentials.env');
      const dockerLog = join(scratch, 'docker.log');
      writeFileSync(envFile, 'OPENAI_API_KEY=test-only\n', { mode: 0o600 });
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, 'docker'),
        `#!/usr/bin/env bash
{
  printf 'CALL'
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$JUROR_TEST_DOCKER_LOG"
if [ "\${1:-}" = 'start' ] && [ "\${2:-}" = '--attach' ]; then
  case "\${3:-}" in
    juror-qa-policy-*) printf '%s\\n' '{"enabled":true,"allowed_origins":[]}' ;;
  esac
fi
if [ "\${1:-}" = 'logs' ]; then
  echo 'juror-qa-egress-proxy ready'
fi
if [ "\${1:-}" = 'inspect' ]; then
  echo '172.19.0.2'
fi
`,
      );
      chmodSync(join(fakeBin, 'docker'), 0o755);
      writeFileSync(
        join(fakeBin, 'jq'),
        `#!/usr/bin/env bash
case "\${1:-}:\${2:-}" in
  '-r:.enabled') echo true ;;
  '-c:.allowed_origins') echo '[]' ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(join(fakeBin, 'jq'), 0o755);

      // A relative path may leave the tested repository through `..`; that is still an
      // operator-owned file as long as no repository-owned child or symlink is selected.
      const envArgument = relative(root, envFile);
      const result = spawnSync('bash', [join(root, 'qa/run-local.sh'), '--env-file', envArgument, '--force'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
          JUROR_QA_IMAGE: 'juror-qa:test',
          JUROR_QA_REPO_DIR: root,
          JUROR_QA_EVIDENCE_DIR: evidenceDir,
          JUROR_QA_CONTAINER_USER: '1000:1000',
          JUROR_TEST_DOCKER_LOG: dockerLog,
          GITHUB_TOKEN: 'test-github-token',
          JUROR_OPENAI_API_KEY: 'test-openai-key',
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(dockerLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\t').slice(1));
      const namedCreate = (prefix: string) => calls.find((call) => {
        if (call[0] !== 'create') return false;
        const nameIndex = call.indexOf('--name');
        return nameIndex >= 0 && call[nameIndex + 1]?.startsWith(prefix);
      });
      const policyCreate = namedCreate('juror-qa-policy-');
      const runtimeCreate = namedCreate('juror-qa-runtime-');
      const mount = `type=bind,src=${realpathSync(envFile)},dst=/run/juror-qa.env,readonly`;

      expect(policyCreate).toBeDefined();
      expect(policyCreate).not.toContain(mount);
      expect(policyCreate).not.toContain('--env-file');
      expect(runtimeCreate).toContain(mount);
      expect(runtimeCreate).toContain('--env-file');
      expect(runtimeCreate?.[runtimeCreate.indexOf('--env-file') + 1]).toBe('/run/juror-qa.env');
      expect(runtimeCreate).toContain(
        `type=bind,src=${realpathSync(root)},dst=/workspace,readonly`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('re-homes linked-worktree Git metadata into read-only fixed container paths', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-run-local-worktree-'));
    try {
      const primary = join(scratch, 'primary');
      const linked = join(scratch, 'linked');
      const fakeBin = join(scratch, 'bin');
      const evidenceDir = join(scratch, 'evidence');
      const linkedLog = join(scratch, 'docker-linked.log');
      const standaloneLog = join(scratch, 'docker-standalone.log');
      mkdirSync(primary);
      mkdirSync(fakeBin);
      const git = (args: string[]) => spawnSync('git', args, {
        cwd: primary,
        encoding: 'utf8',
      });
      expect(git(['init', '--quiet']).status).toBe(0);
      expect(git(['config', 'user.email', 'juror@example.invalid']).status).toBe(0);
      expect(git(['config', 'user.name', 'Juror Test']).status).toBe(0);
      writeFileSync(join(primary, 'README.md'), 'fixture\n');
      expect(git(['add', 'README.md']).status).toBe(0);
      expect(git(['commit', '--quiet', '-m', 'fixture']).status).toBe(0);
      expect(git(['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']).status).toBe(0);

      writeFileSync(
        join(fakeBin, 'docker'),
        `#!/usr/bin/env bash
{
  printf 'CALL'
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$JUROR_TEST_DOCKER_LOG"
if [ "\${1:-}" = 'start' ] && [ "\${2:-}" = '--attach' ]; then
  case "\${3:-}" in
    juror-qa-policy-*) printf '%s\\n' '{"enabled":true,"allowed_origins":[]}' ;;
  esac
fi
if [ "\${1:-}" = 'logs' ]; then
  echo 'juror-qa-egress-proxy ready'
fi
if [ "\${1:-}" = 'inspect' ]; then
  echo '172.19.0.2'
fi
`,
      );
      chmodSync(join(fakeBin, 'docker'), 0o755);
      writeFileSync(
        join(fakeBin, 'jq'),
        `#!/usr/bin/env bash
case "\${1:-}:\${2:-}" in
  '-r:.enabled') echo true ;;
  '-c:.allowed_origins') echo '[]' ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(join(fakeBin, 'jq'), 0o755);

      const run = (repo: string, dockerLog: string) => spawnSync(
        'bash',
        [join(root, 'qa/run-local.sh'), '--force'],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
            JUROR_QA_IMAGE: 'juror-qa:test',
            JUROR_QA_REPO_DIR: repo,
            JUROR_QA_EVIDENCE_DIR: evidenceDir,
            JUROR_QA_CONTAINER_USER: '1000:1000',
            JUROR_TEST_DOCKER_LOG: dockerLog,
            GITHUB_TOKEN: 'test-github-token',
          },
        },
      );
      const parseCalls = (dockerLog: string) => readFileSync(dockerLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\t').slice(1));
      const mounts = (call: string[]) => call.flatMap((argument, index) => (
        argument === '--mount' && call[index + 1] ? [call[index + 1]!] : []
      ));

      const linkedResult = run(linked, linkedLog);
      expect(linkedResult.status, linkedResult.stderr).toBe(0);
      const linkedCalls = parseCalls(linkedLog);
      const linkedCreates = linkedCalls.filter((call) => call[0] === 'create');
      expect(linkedCreates).toHaveLength(2);
      const commonDir = realpathSync(join(primary, '.git'));
      const gitdir = spawnSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8',
      }).stdout.trim();
      for (const create of linkedCreates) {
        const createMounts = mounts(create);
        expect(createMounts).toContain(
          `type=bind,src=${gitdir},dst=/run/juror-worktree.git,readonly`,
        );
        expect(createMounts).toContain(
          `type=bind,src=${commonDir},dst=/run/juror-common.git,readonly`,
        );
        expect(createMounts.find((mount) => mount.includes('dst=/workspace/.git')))
          .toMatch(/^type=bind,src=.*juror-qa-gitfile\.[^,]+,dst=\/workspace\/\.git,readonly$/);
        expect(createMounts.find((mount) => mount.includes('dst=/run/juror-worktree.git/commondir')))
          .toMatch(/^type=bind,src=.*juror-qa-commondir\.[^,]+,dst=\/run\/juror-worktree\.git\/commondir,readonly$/);
        expect(createMounts.find((mount) => mount.includes('dst=/run/juror-worktree.git/gitdir')))
          .toMatch(/^type=bind,src=.*juror-qa-gitdir\.[^,]+,dst=\/run\/juror-worktree\.git\/gitdir,readonly$/);
      }
      const proxy = linkedCalls.find((call) => call[0] === 'run' && call.includes('--detach'));
      expect(proxy).toBeDefined();
      expect(mounts(proxy!)).not.toEqual(expect.arrayContaining([
        expect.stringContaining('/run/juror-worktree.git'),
        expect.stringContaining('/run/juror-common.git'),
      ]));

      const standaloneResult = run(primary, standaloneLog);
      expect(standaloneResult.status, standaloneResult.stderr).toBe(0);
      for (const call of parseCalls(standaloneLog)) {
        expect(call.join('\n')).not.toContain('/run/juror-worktree.git');
        expect(call.join('\n')).not.toContain('/run/juror-common.git');
      }

      const gitfilePath = join(linked, '.git');
      const commondirPath = join(gitdir, 'commondir');
      const originalGitfile = readFileSync(gitfilePath, 'utf8');
      const originalCommondir = readFileSync(commondirPath, 'utf8');

      writeFileSync(gitfilePath, `${originalGitfile.trimEnd()}\nunexpected\n`);
      rmSync(linkedLog, { force: true });
      const multilineGitfile = run(linked, linkedLog);
      expect(multilineGitfile.status, multilineGitfile.stderr).toBe(2);
      expect(multilineGitfile.stderr).toContain('.git file must contain exactly one line');
      expect(parseCalls(linkedLog).some((call) => call[0] === 'create' || call[0] === 'run'))
        .toBe(false);
      writeFileSync(gitfilePath, originalGitfile);

      writeFileSync(commondirPath, `${originalCommondir.trimEnd()}\nunexpected\n`);
      rmSync(linkedLog, { force: true });
      const multilineCommondir = run(linked, linkedLog);
      expect(multilineCommondir.status, multilineCommondir.stderr).toBe(2);
      expect(multilineCommondir.stderr).toContain('commondir must contain exactly one line');
      expect(parseCalls(linkedLog).some((call) => call[0] === 'create' || call[0] === 'run'))
        .toBe(false);

      // A crafted commondir may not widen the exception to an unrelated host directory.
      writeFileSync(commondirPath, '/\n');
      rmSync(linkedLog, { force: true });
      const unsafeResult = run(linked, linkedLog);
      expect(unsafeResult.status, unsafeResult.stderr).toBe(2);
      expect(unsafeResult.stderr).toContain('common Git directory is incomplete');
      expect(parseCalls(linkedLog).some((call) => call[0] === 'create' || call[0] === 'run'))
        .toBe(false);

      const commaPrimary = join(scratch, 'primary,comma');
      const commaLinked = join(scratch, 'linked-comma');
      const commaLog = join(scratch, 'docker-comma.log');
      expect(spawnSync('git', ['clone', '--quiet', primary, commaPrimary]).status).toBe(0);
      expect(spawnSync(
        'git',
        ['-C', commaPrimary, 'worktree', 'add', '--quiet', '--detach', commaLinked, 'HEAD'],
      ).status).toBe(0);
      const commaResult = run(commaLinked, commaLog);
      expect(commaResult.status, commaResult.stderr).toBe(2);
      expect(commaResult.stderr).toContain('metadata paths cannot contain a comma');
      expect(parseCalls(commaLog).some((call) => call[0] === 'create' || call[0] === 'run'))
        .toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects non-files and repository-owned QA environment files before Docker', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-run-local-env-reject-'));
    try {
      const fakeBin = join(scratch, 'bin');
      const dockerLog = join(scratch, 'docker.log');
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, 'docker'),
        `#!/usr/bin/env bash
echo called >> "$JUROR_TEST_DOCKER_LOG"
exit 99
`,
      );
      chmodSync(join(fakeBin, 'docker'), 0o755);
      const testedRepo = join(scratch, 'tested-repo');
      const repoFile = join(testedRepo, 'credentials.env');
      const outsideFile = join(scratch, 'outside.env');
      const outsideLinkToRepo = join(scratch, 'linked-repo.env');
      const repoLinkToOutside = join(testedRepo, 'linked-outside.env');
      const configuredRepoAlias = join(scratch, 'configured-repo-alias');
      const alternateRepoAlias = join(scratch, 'alternate-repo-alias');
      const outsideDirectory = join(scratch, 'operator-tree', 'subdir');
      const repoDirectoryLink = join(testedRepo, 'escape');
      mkdirSync(testedRepo);
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(repoFile, 'OPENAI_API_KEY=repo-owned\n');
      writeFileSync(outsideFile, 'OPENAI_API_KEY=outside\n');
      writeFileSync(join(outsideDirectory, 'nested.env'), 'OPENAI_API_KEY=outside\n');
      symlinkSync(repoFile, outsideLinkToRepo);
      symlinkSync(outsideFile, repoLinkToOutside);
      symlinkSync(testedRepo, configuredRepoAlias, 'dir');
      symlinkSync(testedRepo, alternateRepoAlias, 'dir');
      symlinkSync(outsideDirectory, repoDirectoryLink, 'dir');
      const run = (envFile: string) => spawnSync(
        'bash',
        [join(root, 'qa/run-local.sh'), '--env-file', envFile],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
            JUROR_QA_IMAGE: 'juror-qa:test',
            JUROR_QA_REPO_DIR: configuredRepoAlias,
            JUROR_QA_EVIDENCE_DIR: join(scratch, 'evidence'),
            JUROR_TEST_DOCKER_LOG: dockerLog,
          },
        },
      );

      for (const candidate of [
        join(scratch, 'missing.env'),
        scratch,
        repoFile,
        outsideLinkToRepo,
        repoLinkToOutside,
        join(alternateRepoAlias, 'escape', 'nested.env'),
        `${alternateRepoAlias}/escape/../../outside.env`,
      ]) {
        const result = run(candidate);
        expect(result.status, `${candidate}\n${result.stderr}`).toBe(2);
      }
      expect(() => readFileSync(dockerLog, 'utf8')).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('withholds browser authentication files until local policy opts in', () => {
    const runner = read('qa/run-local.sh');
    const policy = runner.slice(runner.indexOf('POLICY_FILE='), runner.indexOf("if [ \"$(jq -r '.enabled'"));
    const runtime = runner.slice(runner.indexOf('ENV_ARGS=()'));

    expect(policy).toContain('${POLICY_MOUNTS[@]+"${POLICY_MOUNTS[@]}"}');
    expect(policy).not.toContain('${RUNTIME_MOUNTS[@]+"${RUNTIME_MOUNTS[@]}"}');
    expect(runtime).toContain('${RUNTIME_MOUNTS[@]+"${RUNTIME_MOUNTS[@]}"}');
    expect(runner).toContain('RUNTIME_MOUNTS+=(--mount "type=bind,src=$STORAGE_SOURCE');
    expect(runner).not.toContain('POLICY_MOUNTS+=(--mount "type=bind,src=$STORAGE_SOURCE');
  });

  it('preserves in-repository config paths so trusted-base loading cannot be bypassed', () => {
    const runner = read('qa/run-local.sh');
    const configRouting = runner.slice(
      runner.indexOf('CONFIG_PARENT="$(cd "$(dirname "$2")" && pwd -P)"'),
      runner.indexOf('shift 2', runner.indexOf('CONFIG_PARENT="$(cd "$(dirname "$2")" && pwd -P)"')),
    );

    expect(configRouting).toContain('CONFIG_PATH="$CONFIG_PARENT/$(basename "$2")"');
    expect(configRouting).toContain('CONFIG_SOURCE="$(realpath "$2" 2>/dev/null || true)"');
    expect(configRouting).toContain('case "$CONFIG_PATH" in');
    expect(configRouting).toContain('"$REPO_DIR"/*)');
    expect(configRouting).toContain('case "$CONFIG_SOURCE" in');
    expect(configRouting).toContain('CONFIG_RELATIVE="${CONFIG_SOURCE#"$REPO_DIR"/}"');
    expect(configRouting).toContain('RUN_ARGS+=(--config "/workspace/$CONFIG_RELATIVE")');
    expect(configRouting).toContain('dst=/run/juror-config.yml,readonly');
  });

  it('keeps the local credential-bearing runtime workspace read-only', () => {
    const runner = read('qa/run-local.sh');
    const runtimeCreate = runner.slice(
      runner.lastIndexOf('docker create'),
      runner.lastIndexOf('docker start'),
    );

    expect(runtimeCreate).toContain(
      '--mount "type=bind,src=$REPO_DIR,dst=/workspace,readonly"',
    );
    expect(runtimeCreate).toContain(
      '--mount "type=bind,src=$EVIDENCE_DIR,dst=/evidence"',
    );
  });

  it('publishes the QA image only for a verified public release', () => {
    const workflow = read('.github/workflows/release-qa-image.yml');

    expect(workflow).toContain('release:');
    expect(workflow).toContain('types: [published]');
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).not.toContain("push:\n    tags:");
    expect(workflow).toContain('scripts/verify-release.mjs');
    expect(workflow).toContain('npm run typecheck');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run check:secure-refs');
    expect(workflow).toContain('docker logout ghcr.io');
    expect(workflow).toContain('gh attestation verify');
    expect(workflow).toContain('gh release upload');
  });

  it('publishes only a matching tag and produces verifiable release artifacts', () => {
    const workflow = read('.github/workflows/release.yml');

    expect(workflow).toContain('release:');
    expect(workflow).toContain('types: [published]');
    expect(workflow).toContain('attestations: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('scripts/verify-release.mjs');
    expect(workflow).toContain('npm pack');
    expect(workflow).toContain('npm sbom');
    expect(workflow).toContain('sbom-path:');
    expect(workflow).toContain('--provenance --access public');
  });

  it('hands npm a local tarball path instead of a GitHub owner/repo shorthand', () => {
    const workflow = parse(read('.github/workflows/release.yml')) as {
      jobs: { publish: { steps: { run?: string }[] } };
    };
    const publish = workflow.jobs.publish.steps.filter((step) => step.run?.includes('npm publish'));

    // `npm publish release/juror-ai-1.4.0.tgz` resolved as `github:release/juror-ai-1.4.0.tgz`
    // and failed the v1.4.0 release. Only an explicitly relative or absolute path is read as
    // the packed file rather than as an `owner/repo` git spec.
    expect(publish).toHaveLength(1);
    expect(publish[0]?.run).toMatch(/npm publish "(\.\/|\/)/);
  });

  it('rejects release identity mismatches before building or publishing', () => {
    const sha = 'a'.repeat(40);
    const valid = {
      tag: 'v1.3.3',
      version: '1.3.3',
      eventSha: sha,
      headSha: sha,
      tagSha: sha,
      repository: 'git+https://github.com/Juror-AI/juror.git',
    };

    expect(releaseIdentityErrors(valid)).toEqual([]);
    expect(releaseIdentityErrors({ ...valid, tag: 'v1.3.2' })).toContain(
      'release tag v1.3.2 does not match package version 1.3.3',
    );
    expect(releaseIdentityErrors({ ...valid, tagSha: 'b'.repeat(40) })).toContain(
      `checked-out commit ${sha} does not match tag commit ${'b'.repeat(40)}`,
    );
  });

  it('documents private reporting expectations and the complete threat boundary', () => {
    const security = read('SECURITY.md');
    const threatModel = read('docs/threat-model.md');

    expect(security).toContain('/security/advisories/new');
    expect(security).toMatch(/business days/i);
    for (const boundary of [
      'untrusted pull request',
      'provider keys',
      'GitHub token',
      'model subprocesses',
      'installer scripts',
      'Action dependencies',
    ]) {
      expect(threatModel.toLowerCase()).toContain(boundary.toLowerCase());
    }
  });
});
