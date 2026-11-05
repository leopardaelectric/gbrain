/**
 * Tier 2 e2e: spawn REAL openclaw, install our plugin from a built bundle of
 * `src/openclaw-context-engine.ts`, and assert the OpenClaw runtime actually
 * loads it, registers our default-export metadata, accepts it as the
 * `contextEngine` slot, and runs `plugins doctor` with zero error-level
 * diagnostics for our plugin id.
 *
 * Why this exists:
 *   The unit/e2e tests in test/context-engine.test.ts and
 *   test/e2e/openclaw-context-engine-plugin.test.ts both run STANDALONE —
 *   they mock the OpenClaw SDK or call our engine factory directly. Codex
 *   outside-voice F1 flagged that nothing in the repo proves OpenClaw's
 *   actual plugin loader walks our entry file, calls register(api), and
 *   accepts the registration. This test closes that gap.
 *
 * What this exercises end-to-end:
 *   1. `bun build` our entry → JS bundle (the same build the release would
 *      ship to ClawHub).
 *   2. `openclaw plugins install --link` against an isolated `--profile`
 *      directory.
 *   3. `openclaw plugins inspect <id> --json` (with `--runtime` on older
 *      CLIs — see inspectRuntime) imports the plugin and reads our
 *      default-export shape back from the runtime registry
 *      (`status: 'loaded'`, `imported: true`, id/name/description match).
 *   4. `openclaw config set plugins.slots.contextEngine gbrain-context` →
 *      `openclaw config validate` confirms the slot binding is accepted.
 *   5. `openclaw plugins doctor` surfaces zero error-level diagnostics for
 *      our id.
 *   6. Public-SDK round-trip: resolve the installed package's exported
 *      `openclaw/plugin-sdk/core`, use `definePluginEntry`, and execute the
 *      factory captured from the real entry's register() under Node.
 *
 * Skips gracefully when `openclaw` CLI is unavailable (Tier 2 like
 * test/e2e/skills.test.ts). Uses an isolated `--profile` so the user's real
 * openclaw state is untouched; cleans up the profile + plugin install in
 * afterAll regardless of test outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { createRequire } from 'node:module';
import { tmpdir } from 'os';

// ── Tier 2 gating ──────────────────────────────────────────────────────────
const OPENCLAW = which('openclaw');
const SKIP = !OPENCLAW;
const SKIP_MSG = '[openclaw-plugin-load-real] openclaw CLI not available; skipping Tier 2 e2e';

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const path = r.stdout.trim();
  return path || null;
}

// Hardcoded plugin id matches src/openclaw-context-engine.ts default export.
const PLUGIN_ID = 'gbrain-context-engine';
const ENGINE_ID = 'gbrain-context';
// Use a process-unique profile name so two concurrent test runs (e.g.,
// Conductor sibling workspaces) don't collide on `~/.openclaw-<profile>`.
const PROFILE = `gbrain-ctx-e2e-${process.pid}`;
// Isolate even bare invocations, not only scripts/run-e2e.sh. Never inherit
// provider keys, database URLs, or OPENCLAW_* overrides into the CLI host.
const HOST_HOME = SKIP ? '' : mkdtempSync(join(tmpdir(), 'gbrain-ctx-host-'));

let fixtureDir = '';
let repoRoot = '';

function runOpenclaw(args: string[], opts: { timeoutMs?: number } = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(OPENCLAW!, ['--profile', PROFILE, ...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    env: { PATH: process.env.PATH, HOME: HOST_HOME, GBRAIN_HOME: HOST_HOME },
  });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Version-robust runtime inspect. The test was pinned to
 * `plugins inspect <id> --runtime --json` (#3742), but OpenClaw has since
 * folded the runtime import into the default inspect and REMOVED the
 * `--runtime` flag (observed on OpenClaw 2026.4.10: `error: unknown option
 * '--runtime'`, while plain `inspect --json` reports status/imported/
 * activated + diagnostics). Try the flagged form first for older CLIs and
 * fall back to the plain form when the flag is unknown, so the assertions
 * pin the plugin-load contract rather than one CLI version's flag surface.
 */
function inspectRuntime(id: string): { exitCode: number; stdout: string; stderr: string } {
  const flagged = runOpenclaw(['plugins', 'inspect', id, '--runtime', '--json'], { timeoutMs: 30_000 });
  if (flagged.exitCode === 0) return flagged;
  if (/unknown option '--runtime'/.test(`${flagged.stdout}\n${flagged.stderr}`)) {
    return runOpenclaw(['plugins', 'inspect', id, '--json'], { timeoutMs: 30_000 });
  }
  return flagged;
}

function cleanup() {
  if (!OPENCLAW) return;
  // Best-effort: uninstall the plugin and rm the profile dir. Both may
  // already be gone (e.g., beforeAll partial failure); ignore errors.
  try {
    runOpenclaw(['plugins', 'uninstall', '--force', PLUGIN_ID], { timeoutMs: 30_000 });
  } catch { /* noop */ }
  try {
    if (HOST_HOME && existsSync(HOST_HOME)) rmSync(HOST_HOME, { recursive: true, force: true });
  } catch { /* noop */ }
  try {
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  } catch { /* noop */ }
}

describe('openclaw-plugin-load-real (Tier 2 e2e)', () => {
  beforeAll(async () => {
    if (SKIP) {
      console.warn(SKIP_MSG);
      return;
    }

    repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
      .stdout.trim();
    if (!repoRoot) throw new Error('not in a git repo — cannot resolve plugin source path');

    fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-ctx-plugin-real-'));

    // Write the fixture's package.json + openclaw.plugin.json from templates.
    const fixtureTemplate = join(repoRoot, 'test', 'fixtures', 'openclaw-plugin-real');
    writeFileSync(
      join(fixtureDir, 'package.json'),
      readFileSync(join(fixtureTemplate, 'package.json.template'), 'utf8'),
    );
    writeFileSync(
      join(fixtureDir, 'openclaw.plugin.json'),
      readFileSync(join(fixtureTemplate, 'openclaw.plugin.json.template'), 'utf8'),
    );

    // Build our real entry into the fixture dir. This is the same source
    // (`src/openclaw-context-engine.ts`) that the release ships; only the
    // packaging layer (test fixture's package.json) is test-specific.
    //
    // OpenClaw loads plugins in Node, not Bun. The Node target must reject
    // Bun-only builtins rather than silently compiling references to global Bun.
    // `--outdir` (not `--outfile`): since the Retrieval Reflex ladder
    // (v0.42.39.0, 8f45624e5 #2019) the entry's import chain reaches
    // engine-factory → pglite-engine → @electric-sql/pglite, whose WASM/
    // data assets become sibling build outputs — and `bun build` refuses
    // `--outfile` when a build produces multiple output files. The fixed
    // `--entry-naming` keeps the bundle at `entry.js`, matching the
    // fixture package.json's `openclaw.extensions` entry; the assets land
    // alongside it in the same directory, where the bundle's relative
    // references resolve.
    const buildResult = spawnSync(
      'bun',
      [
        'build',
        join(repoRoot, 'src', 'openclaw-context-engine.ts'),
        '--target=node',
        '--outdir',
        fixtureDir,
        '--entry-naming',
        '[dir]/entry.[ext]',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (buildResult.status !== 0) {
      throw new Error(`bun build failed (exit ${buildResult.status}): ${buildResult.stderr}`);
    }
    if (!existsSync(join(fixtureDir, 'entry.js'))) {
      throw new Error('bun build did not produce entry.js');
    }

    // Install via openclaw plugins install --link into the isolated profile.
    // Consent applies only to our disposable local fixture/profile. Detect
    // the supported flags; do not change host install policy or retry installs.
    const installHelp = runOpenclaw(['plugins', 'install', '--help']);
    if (installHelp.exitCode !== 0) throw new Error(installHelp.stderr);
    const help = `${installHelp.stdout}\n${installHelp.stderr}`;
    const trustFlag = /(?:^|\s)--force(?:[ ,]|$)/m.test(help)
      ? '--force'
      : '--dangerously-force-unsafe-install';
    const install = runOpenclaw([
      'plugins', 'install',
      '--link',
      trustFlag,
      ...(/--accept-capabilities/.test(help) ? ['--accept-capabilities'] : []),
      fixtureDir,
    ], { timeoutMs: 60_000 });
    if (install.exitCode !== 0) {
      throw new Error(
        `openclaw plugins install failed (exit ${install.exitCode}).\n` +
        `stdout: ${install.stdout}\nstderr: ${install.stderr}`,
      );
    }
  });

  afterAll(() => {
    cleanup();
  });

  it.skipIf(SKIP)(
    'openclaw imports the entry file and reports status=loaded',
    () => {
      const r = inspectRuntime(PLUGIN_ID);
      expect(r.exitCode).toBe(0);

      const inspect = JSON.parse(r.stdout);
      expect(inspect.plugin).toBeDefined();
      // status=loaded means: openclaw imported the entry.js module, read the
      // default export, and called register(api) without throwing.
      expect(inspect.plugin.status).toBe('loaded');
      expect(inspect.plugin.imported).toBe(true);
      expect(inspect.plugin.activated).toBe(true);
    },
  );

  it.skipIf(SKIP)(
    'default export carries the expected id / name / description metadata',
    () => {
      const r = inspectRuntime(PLUGIN_ID);
      expect(r.exitCode).toBe(0);
      const inspect = JSON.parse(r.stdout);

      // Openclaw reads these directly from the default export of our entry.
      // If we rename a field in src/openclaw-context-engine.ts, this fails.
      expect(inspect.plugin.id).toBe(PLUGIN_ID);
      expect(inspect.plugin.name).toBe('GBrain Context Engine');
      expect(inspect.plugin.description).toContain('Deterministic temporal/spatial context injection');
    },
  );

  it.skipIf(SKIP)(
    'register(api) ran without producing error-level diagnostics',
    () => {
      const r = inspectRuntime(PLUGIN_ID);
      expect(r.exitCode).toBe(0);
      const inspect = JSON.parse(r.stdout);

      const errors = (inspect.diagnostics ?? []).filter((d: { level: string }) => d.level === 'error');
      expect(errors).toEqual([]);

      // Linked installs may or may not emit provenance warnings depending on
      // the OpenClaw version. Registration errors are the stable contract.
    },
  );

  it.skipIf(SKIP)(
    'plugins.slots.contextEngine binding to gbrain-context validates cleanly',
    () => {
      // Wiring our id into the slot is the runtime hand-off — when
      // openclaw initializes an agent, it reads this slot and resolves the
      // engine from the contextEngine registry. config validate fails if
      // the slot value doesn't reference a known engine.
      const setResult = runOpenclaw(
        ['config', 'set', 'plugins.slots.contextEngine', ENGINE_ID],
        { timeoutMs: 30_000 },
      );
      expect(setResult.exitCode).toBe(0);

      const validateResult = runOpenclaw(['config', 'validate'], { timeoutMs: 30_000 });
      expect(validateResult.exitCode).toBe(0);
      expect(validateResult.stdout).toContain('Config valid');
    },
  );

  it.skipIf(SKIP)(
    'plugins doctor produces zero errors for our plugin id',
    () => {
      const r = runOpenclaw(['plugins', 'doctor'], { timeoutMs: 30_000 });
      // Doctor may exit non-zero overall if ANY plugin has issues; the
      // assertion we care about is that OUR id is not in an error line.
      // Match a "${PLUGIN_ID}: <message>" pattern with error keywords.
      const combined = `${r.stdout}\n${r.stderr}`;
      const lines = combined.split('\n').filter(l => l.includes(PLUGIN_ID));
      const errorLines = lines.filter(l =>
        /error|failed|cannot|missing|not registered/i.test(l)
        && !l.includes('without install/load-path provenance'), // expected trust warning
      );
      if (errorLines.length > 0) {
        console.error('Unexpected error lines for', PLUGIN_ID, ':\n', errorLines.join('\n'));
      }
      expect(errorLines).toEqual([]);
    },
  );

  it.skipIf(SKIP)(
    'openclaw public SDK accepts our entry and its registered factory runs in Node',
    () => {
      // Current OpenClaw exposes registration on OpenClawPluginApi, NOT a
      // standalone registerContextEngine export. Use its public entry helper,
      // then exercise the factory delivered by our real register() in Node.
      // The preceding runtime inspections prove the REAL host registry accepts
      // this entry; this guard checks the public SDK and factory execution.
      // Do not assume the first CLI on PATH is a package: agent launchers can
      // be shell shims. Walk all PATH candidates, follow symlinks, verify the
      // package identity and resolve through its PUBLIC exports map.
      let sdkPath: string | undefined;
      const resolutionErrors: string[] = [];
      for (const binDir of (process.env.PATH ?? '').split(delimiter)) {
        const candidate = join(binDir, 'openclaw');
        if (!existsSync(candidate)) continue;
        let dir = dirname(realpathSync(candidate));
        while (true) {
          const pkgPath = join(dir, 'package.json');
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            if (pkg.name === 'openclaw') {
              try {
                sdkPath = createRequire(pkgPath).resolve('openclaw/plugin-sdk/core');
              } catch (err) {
                resolutionErrors.push(`${pkgPath}: ${String(err)}`);
              }
              break;
            }
          }
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        if (sdkPath) break;
      }
      if (!sdkPath) throw new Error(`Cannot resolve installed OpenClaw public SDK: ${resolutionErrors.join('; ')}`);

      const tmp = mkdtempSync(join(tmpdir(), 'gbrain-ctx-sdk-rt-'));
      try {
        mkdirSync(join(tmp, 'memory'), { recursive: true });
        writeFileSync(join(tmp, 'memory', 'heartbeat-state.json'), '{}');
        writeFileSync(join(tmp, 'memory', 'upcoming-flights.json'), '{}');
        const probePath = join(tmp, 'probe.mjs');
        writeFileSync(probePath, `
          import assert from 'node:assert/strict';
          import { pathToFileURL } from 'node:url';
          assert.equal(globalThis.Bun, undefined, 'must execute in the real Node host');
          const { definePluginEntry } = await import(pathToFileURL(${JSON.stringify(sdkPath)}).href);
          assert.equal(typeof definePluginEntry, 'function');
          const { default: entry } = await import(pathToFileURL(${JSON.stringify(join(fixtureDir, 'entry.js'))}).href);
          const plugin = definePluginEntry(entry);
          assert.equal(plugin.id, ${JSON.stringify(PLUGIN_ID)});
          let registeredId;
          let registeredFactory;
          plugin.register({ registerContextEngine(id, factory) {
            assert.equal(registeredFactory, undefined, 'must register exactly once');
            registeredId = id;
            registeredFactory = factory;
          } });
          assert.equal(registeredId, ${JSON.stringify(ENGINE_ID)});
          assert.equal(typeof registeredFactory, 'function');
          const engine = await registeredFactory({ workspaceDir: ${JSON.stringify(tmp)} });
          assert.equal(engine.info.id, ${JSON.stringify(ENGINE_ID)});
          for (const method of ['ingest', 'assemble', 'compact']) assert.equal(typeof engine[method], 'function');
          const result = await engine.assemble({ sessionId: 'sdk-roundtrip', messages: [] });
          assert.match(result.systemPromptAddition, /Live Context/);
          console.log(JSON.stringify({ node: process.version, sdk: 'openclaw/plugin-sdk/core', registeredId, assembled: true }));
        `);
        // No database URL or provider credentials cross this boundary. HOME
        // remains disposable and the zero-message assemble needs no brain.
        const r = spawnSync('node', [probePath], {
          encoding: 'utf8', timeout: 30_000,
          env: { PATH: process.env.PATH, HOME: tmp, GBRAIN_HOME: tmp },
        });
        if (r.status !== 0) throw new Error(`Node SDK round-trip failed:\n${r.stdout}\n${r.stderr}`);
        const result = JSON.parse(r.stdout);
        expect(result.registeredId).toBe(ENGINE_ID);
        expect(result.assembled).toBe(true);
        expect(result.sdk).toBe('openclaw/plugin-sdk/core');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
