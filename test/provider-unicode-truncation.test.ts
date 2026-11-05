import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';
import { renderSegmentForExtraction, SEGMENT_TEXT_CHAR_LIMIT } from '../src/commands/extract-conversation-facts.ts';

beforeEach(() => {
  resetGateway();
  configureGateway({ chat_model: 'openai:gpt-5.6-terra', env: { OPENAI_API_KEY: 'synthetic-offline-key' } });
});
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

test('renderer does not create a lone high surrogate at the segment limit', () => {
  const start = '2026-01-01T00:00:00Z';
  const end = '2026-01-01T00:01:00Z';
  const header = `Page: Synthetic\nConversation between Speaker A from ${start} to ${end}\n---`;
  const linePrefix = `Speaker A (${start}): `;
  const cut = SEGMENT_TEXT_CHAR_LIMIT - header.length - 16;
  const text = 'A'.repeat(cut - linePrefix.length - 1) + '\u{1F680}' + 'B'.repeat(100);
  const rendered = renderSegmentForExtraction('Synthetic', {
    participants: ['Speaker A'], startIso: start, endIso: end,
    messages: [{ speaker: 'Speaker A', timestamp: start, text }],
  } as any);
  expect(rendered).toEndWith('A\n…(truncated)');
  expect(rendered).not.toMatch(/[\uD800-\uDBFF]\n…\(truncated\)$/);
});

test('extractor input limit does not create a lone high surrogate', async () => {
  let seen = '';
  __setChatTransportForTests(async (opts) => {
    seen = String(opts.messages[0]?.content);
    return { text: '{"facts":[]}', blocks: [{ type: 'text', text: '{"facts":[]}' }],
      stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-5.6-terra', providerId: 'openai' };
  });
  const out = await extractFactsFromTurnWithOutcome({
    turnText: 'A'.repeat(7999) + '\u{1F680}' + 'B', source: 'test:unicode-limit', model: 'openai:gpt-5.6-terra',
  });
  expect(out).toMatchObject({ ok: true, facts: [] });
  expect(seen).toContain('A'.repeat(7999) + '\n</turn>');
  expect(seen).not.toContain('\ud83d');
});
