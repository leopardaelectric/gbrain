/** Page provenance transport only: real in-memory engine, stubbed chat, no providers.
 * Serial because CLI mode and gateway transport are process-global test seams.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { __resetShortLivedCliForTests, markShortLivedCliProcess } from '../src/core/facts/cli-process-mode.ts';
import { __resetFactsQueueForTests, getFactsQueue } from '../src/core/facts/queue.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import type { MinionHandler, MinionJobContext } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let brainDir: string;
let workerHandler: MinionHandler;
let chatCalls = 0;
const SOURCE_ID = 'provenance-source';
const jobCtx = (data: Record<string, unknown>): MinionJobContext => ({
  id: 1, name: 'facts-absorb', data, attempts_made: 0, deadlineAtMs: null,
  signal: new AbortController().signal, shutdownSignal: new AbortController().signal,
  updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
  isActive: async () => true, readInbox: async () => [],
});
const page = {
  slug: 'meetings/known-origin',
  type: 'meeting' as const,
  compiled_truth: 'A substantive meeting records a durable decision and its original source page. '.repeat(4),
  frontmatter: {},
};
const ctx = (overrides: Partial<FactsBackstopCtx> = {}): FactsBackstopCtx => ({
  engine, sourceId: SOURCE_ID, sessionId: 'provenance-session', source: 'mcp:put_page', ...overrides,
});

beforeAll(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-backstop-provenance-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
    [SOURCE_ID, 'Provenance fixture', brainDir],
  );
  // Same slug in two sources: worker lookup and inserts must retain sourceId.
  for (const sourceId of [SOURCE_ID, 'default']) {
    await engine.putPage(page.slug, { ...page, title: 'Origin fixture' }, { sourceId });
  }
  const handlers = new Map<string, MinionHandler>();
  await registerBuiltinHandlers({ register: (name: string, fn: MinionHandler) => handlers.set(name, fn) } as never,
    engine, { quiet: true });
  workerHandler = handlers.get('facts-absorb')!;
  expect(workerHandler).toBeDefined();
});

beforeEach(async () => {
  __resetShortLivedCliForTests();
  __resetFactsQueueForTests();
  resetGateway();
  chatCalls = 0;
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'facts-absorb'`);
  __setChatTransportForTests(async () => {
    chatCalls++;
    return {
      text: JSON.stringify({ facts: [{ fact: 'The fixture decision remains unresolved.', kind: 'fact',
        entity: 'unknownentity', confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    };
  });
});

afterEach(async () => {
  await getFactsQueue().drainPending({ timeout: 2000 });
  __resetFactsQueueForTests();
  __resetShortLivedCliForTests();
  __setChatTransportForTests(null);
  resetGateway();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

async function assertFallback(expectedContext: string | null) {
  const rows = await engine.executeRaw<{
    entity_slug: string; source_id: string; context: string | null;
    source_session: string; source_markdown_slug: string | null; source: string;
  }>(`SELECT entity_slug, source_id, context, source_session, source_markdown_slug, source FROM facts`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    entity_slug: 'unknownentity', source_id: SOURCE_ID, context: expectedContext,
    source_session: 'provenance-session', source_markdown_slug: null, source: 'mcp:put_page',
  });
  expect(await engine.getPage('unknownentity', { sourceId: SOURCE_ID })).toBeNull();
  expect(await engine.getPage('unknownentity', { sourceId: 'default' })).toBeNull();
  expect(existsSync(join(brainDir, 'unknownentity.md'))).toBe(false);
  expect(readdirSync(brainDir).filter(name => name.endsWith('.md'))).toEqual([]);
  expect(chatCalls).toBe(1);
}

for (const mode of ['inline', 'queue'] as const) {
  describe(`${mode} page provenance`, () => {
    for (const sourceSlug of [undefined, 'transcripts/explicit-origin', '']) {
      test(`retains sourceId and ${sourceSlug === undefined ? 'defaults to the known page' : `preserves explicit ${JSON.stringify(sourceSlug)}`}`, async () => {
        const inputCtx = ctx({ mode, ...(sourceSlug === undefined ? {} : { sourceSlug }) });
        const originalCtx = { ...inputCtx };
        const result = await runFactsBackstop(page, inputCtx);
        if (result.mode === 'queue') {
          expect(result.enqueued).toBe(true);
          expect((await getFactsQueue().drainPending({ timeout: 2000 })).unfinished).toBe(0);
          expect(getFactsQueue().getCounters().completed).toBe(1);
        } else {
          expect(result.inserted).toBe(1);
        }
        expect(inputCtx).toEqual(originalCtx);
        await assertFallback(sourceSlug ?? page.slug);
      });
    }
  });
}

describe('durable submit → serialized payload → real worker handler', () => {
  for (const sourceSlug of [undefined, 'transcripts/durable-override', '']) {
    test(`transports ${sourceSlug === undefined ? 'known page default' : `explicit ${JSON.stringify(sourceSlug)}`} without provider work at submission`, async () => {
      markShortLivedCliProcess();
      const result = await runFactsBackstop(page, ctx({ ...(sourceSlug === undefined ? {} : { sourceSlug }) }));
      expect(result).toEqual({ mode: 'queue', enqueued: true, queueDepth: 0 });
      expect(chatCalls).toBe(0);
      const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
        `SELECT data FROM minion_jobs WHERE name = 'facts-absorb'`,
      );
      expect(jobs).toHaveLength(1);
      const data = JSON.parse(JSON.stringify(jobs[0].data));
      expect(data.sourceSlug).toBe(sourceSlug ?? page.slug);
      expect(data.sourceId).toBe(SOURCE_ID);
      expect(data.slug).toBe(page.slug);
      __resetShortLivedCliForTests();
      const outcome = await workerHandler(jobCtx(data));
      expect(outcome).toMatchObject({ mode: 'inline', inserted: 1 });
      await assertFallback(sourceSlug ?? page.slug);
    });
  }

  test('old queued payload without sourceSlug defaults from the source-qualified page', async () => {
    const outcome = await workerHandler(jobCtx({ slug: page.slug, sourceId: SOURCE_ID,
      source: 'mcp:put_page', sessionId: 'provenance-session' }));
    expect(outcome).toMatchObject({ mode: 'inline', inserted: 1 });
    await assertFallback(page.slug);
  });
});

for (const sourceSlug of [undefined, 'transcripts/raw-explicit']) {
  test(`raw pipeline ${sourceSlug === undefined ? 'keeps absent context null' : 'retains explicit context'}`, async () => {
    const result = await runFactsPipeline(page.compiled_truth, ctx({ ...(sourceSlug === undefined ? {} : { sourceSlug }) }));
    expect(result.inserted).toBe(1);
    expect(result.entity_slugs).toEqual([]);
    await assertFallback(sourceSlug ?? null);
  });
}
