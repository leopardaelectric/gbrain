import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CUTOVER = join(REPO_ROOT, 'scripts', 'gbrain-cutover.sh');

let tempRoot: string;
let fakeBin: string;
let logPath: string;

function installFake(name: string, body: string): void {
  const path = join(fakeBin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function runCutover(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [CUTOVER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      FAKE_LOG: logPath,
      ...env,
    },
  });
}

function logLines(): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'gbrain-cutover-'));
  fakeBin = join(tempRoot, 'bin');
  logPath = join(tempRoot, 'calls.log');
  mkdirSync(fakeBin);
  writeFileSync(logPath, '');

  installFake('systemctl', `
printf 'systemctl %s\\n' "$*" >> "$FAKE_LOG"
if [[ "\${FAKE_FAIL_SYSTEMCTL_CALL:-}" == "$*" ]]; then
  exit 1
fi
if [[ "\${FAKE_INACTIVE_UNIT:-}" == "\${4:-}" && "\${1:-} \${2:-} \${3:-}" == "--user is-active --quiet" ]]; then
  exit 3
fi
exit 0`);

  installFake('curl', `
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
if [[ "\${FAKE_CURL_RESULT:-ok}" == "fail" ]]; then
  exit 22
fi
exit 0`);

  installFake('timeout', `
printf 'timeout %s\\n' "$*" >> "$FAKE_LOG"
if [[ "\${FAKE_TIMEOUT_RESULT:-run}" == "timeout" ]]; then
  exit 124
fi
[[ "\${1:-}" == "--foreground" ]]
shift
if [[ "\${1:-}" == "--kill-after=5s" ]]; then
  shift
fi
shift
exec "$@"`);
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('gbrain-cutover.sh', () => {
  test('refuses the cutover before stopping services when a precheck fails', () => {
    const result = runCutover(['--', 'true'], {
      FAKE_INACTIVE_UNIT: 'gbrain-postgres.service',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('preflight failed');
    expect(logLines()).toEqual([
      'systemctl --user is-active --quiet gbrain-postgres.service',
    ]);
  });

  test('requires an explicit command delimiter', () => {
    const result = runCutover(['true']);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('command must follow --');
    expect(logLines()).toEqual([]);
  });

  test('returns 124 and restores both services when the cutover times out', () => {
    const result = runCutover(['--timeout-seconds', '7', '--', 'true'], {
      FAKE_TIMEOUT_RESULT: 'timeout',
    });

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('timed out after 7 seconds');
    expect(logLines()).toContain('timeout --foreground --kill-after=5s 7s true');
    expect(logLines().slice(-4)).toEqual([
      'systemctl --user start gbrain-http.service',
      'systemctl --user start gbrain-autopilot.service',
      'curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3131/health',
      'systemctl --user is-active --quiet gbrain-autopilot.service',
    ]);
  });

  test('preserves command failure and restores both services', () => {
    const result = runCutover(['--', 'bash', '-c', 'exit 42']);

    expect(result.status).toBe(42);
    expect(result.stderr).toContain('cutover command failed with exit 42');
    expect(logLines()).toContain('systemctl --user start gbrain-http.service');
    expect(logLines()).toContain('systemctl --user start gbrain-autopilot.service');
  });

  test('polls local health even when a service start command fails', () => {
    const result = runCutover(['--', 'true'], {
      FAKE_FAIL_SYSTEMCTL_CALL: '--user start gbrain-autopilot.service',
    });

    expect(result.status).toBe(1);
    expect(logLines().filter((line) => line.startsWith('curl '))).toHaveLength(2);
  });

  test('restores both services after TERM', () => {
    const result = runCutover(['--', 'bash', '-c', 'kill -TERM "$PPID"; exit 0']);

    expect(result.status).toBe(143);
    expect(logLines()).toContain('systemctl --user start gbrain-http.service');
    expect(logLines()).toContain('systemctl --user start gbrain-autopilot.service');
  });

  test('runs a healthy bounded cutover and waits for local health', () => {
    const result = runCutover(['--', 'true']);

    expect(result.status).toBe(0);
    expect(logLines()).toEqual([
      'systemctl --user is-active --quiet gbrain-postgres.service',
      'systemctl --user is-active --quiet gbrain-http.service',
      'systemctl --user is-active --quiet gbrain-autopilot.service',
      'curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3131/health',
      'systemctl --user stop gbrain-autopilot.service',
      'systemctl --user stop gbrain-http.service',
      'timeout --foreground --kill-after=5s 60s true',
      'systemctl --user start gbrain-http.service',
      'systemctl --user start gbrain-autopilot.service',
      'curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3131/health',
      'systemctl --user is-active --quiet gbrain-autopilot.service',
    ]);
    expect(result.stdout).toContain('cutover complete');
  });
});
