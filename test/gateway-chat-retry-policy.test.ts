import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chat, configureGateway, resetGateway, __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';

beforeEach(() => {
  resetGateway();
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'synthetic-test-key' },
  });
});
afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('chat SDK retry policy', () => {
  for (const maxRetries of [undefined, 0, 1]) {
    test(`forwards ${maxRetries ?? 'default'} retries to the SDK without network`, async () => {
      let calls = 0;
      __setGenerateTextTransportForTests(async (opts) => {
        calls++;
        expect(opts.maxRetries).toBe(maxRetries);
        expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
        throw new Error('synthetic SDK boundary');
      });
      await expect(chat({ messages: [{ role: 'user', content: 'synthetic' }], maxRetries }))
        .rejects.toThrow('synthetic SDK boundary');
      expect(calls).toBe(1);
    });
  }
});
