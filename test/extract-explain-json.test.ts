import { describe, expect, test } from 'bun:test';

import { stringifyExtractExplainJson } from '../src/commands/extract-explain.ts';

describe('extract --explain JSON output', () => {
  test('serializes Postgres bigint rollup counters without losing precision', () => {
    const json = stringifyExtractExplainJson({
      rollup_7d: { halt_count: 9_007_199_254_740_993n },
    });

    expect(JSON.parse(json)).toEqual({
      rollup_7d: { halt_count: '9007199254740993' },
    });
  });
});
