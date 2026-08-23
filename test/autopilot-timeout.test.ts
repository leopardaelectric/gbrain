import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAutopilotJobTimeoutMs } from '../src/commands/autopilot.ts';
import { resolveConversationFactsSourceTimeoutMs } from '../src/core/cycle/conversation-facts-backfill.ts';

const AUTOPILOT_SOURCE = readFileSync(
  resolve(import.meta.dir, '../src/commands/autopilot.ts'),
  'utf8',
);
const CONVERSATION_BACKFILL_SOURCE = readFileSync(
  resolve(import.meta.dir, '../src/core/cycle/conversation-facts-backfill.ts'),
  'utf8',
);

describe('resolveAutopilotJobTimeoutMs', () => {
  test('defaults to a 90 minute floor at the standard 5 minute interval', () => {
    expect(resolveAutopilotJobTimeoutMs(300)).toBe(90 * 60 * 1000);
  });

  test('still scales with longer intervals above the floor', () => {
    expect(resolveAutopilotJobTimeoutMs(3_600)).toBe(120 * 60 * 1000);
  });
});

describe('fatal reconnect shutdown', () => {
  test('drains the managed worker and exits non-zero through shutdown', () => {
    expect(AUTOPILOT_SOURCE).toContain("await shutdown('unrecoverable-db-error', 1);");
    expect(AUTOPILOT_SOURCE).toContain("await shutdown('reconnect-failure-cap', 1);");
    expect(AUTOPILOT_SOURCE).not.toMatch(/process\.exitCode = 1;\s*break;/);
  });
});

describe('conversation facts cycle bounds', () => {
  test('uses the smaller of the per-source and remaining global deadlines', () => {
    expect(resolveConversationFactsSourceTimeoutMs(20, 30, 0)).toBe(20 * 60_000);
    expect(resolveConversationFactsSourceTimeoutMs(20, 30, 25 * 60_000)).toBe(5 * 60_000);
    expect(resolveConversationFactsSourceTimeoutMs(20, 30, 31 * 60_000)).toBe(1);
  });

  test('caps each source invocation to a resumable background-sized slice', () => {
    expect(CONVERSATION_BACKFILL_SOURCE).toContain('BACKGROUND_SLICE_LIMIT');
    expect(CONVERSATION_BACKFILL_SOURCE).toMatch(
      /runExtractConversationFactsCore\([\s\S]*?limit:\s*BACKGROUND_SLICE_LIMIT/,
    );
    expect(CONVERSATION_BACKFILL_SOURCE).toContain(
      'const perSourceWallMs = resolveConversationFactsSourceTimeoutMs',
    );
    expect(CONVERSATION_BACKFILL_SOURCE).toMatch(
      /runExtractConversationFactsCore\([\s\S]*?, controller\.signal\)/,
    );
  });
});
