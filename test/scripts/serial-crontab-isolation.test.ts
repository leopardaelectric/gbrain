import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = resolve(import.meta.dir, '../helpers/crontab-fixture.sh');
test('serial crontab fixture isolates HOME namespaces and never needs a real scheduler', () => {
  const root = mkdtempSync(join(tmpdir(), 'serial-crontab-'));
  try {
    const run = (home: string, arg: string, input?: string) => spawnSync('bash', [helper, arg], {
      encoding: 'utf8', input,
      env: { PATH: '/usr/bin:/bin', HOME: home, GBRAIN_TEST_CRONTAB_DIR: join(root, 'state') },
    });
    const a = join(root, 'home-a'), b = join(root, 'home-b');
    expect(run(a, '-l').status).toBe(1);
    const line = '*/15 * * * * /synthetic/pull # synthetic-source\n';
    expect(run(a, '-', line).status).toBe(0);
    expect(run(a, '-l').stdout).toBe(line);
    expect(run(b, '-l').status).toBe(1);
    expect(run(a, '-r').status).toBe(0);
    expect(run(a, '-l').status).toBe(1);
    expect(run(a, '--unsupported').status).toBe(64);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
