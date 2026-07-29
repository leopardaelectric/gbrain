import { describe, expect, test } from 'bun:test';
import {
  upsertConsolidatedTakeBody,
} from '../src/core/cycle/consolidate-takes-fs.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';

describe('upsertConsolidatedTakeBody', () => {
  test('appends a promoted take to a page without a takes fence', () => {
    const result = upsertConsolidatedTakeBody(
      '---\ntype: project\ntitle: Maestro\n---\n\n# Maestro\n',
      {
        claim: 'Maestro retries failed maintenance writes.',
        weight: 0.9,
        sinceDate: '2026-07-01',
        source: 'slack:a,slack:b',
      },
      { preferredRowNum: 4 },
    );

    expect(result.created).toBe(true);
    expect(result.rowNum).toBe(4);
    const parsed = parseTakesFence(result.body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.takes).toEqual([
      expect.objectContaining({
        rowNum: 4,
        claim: 'Maestro retries failed maintenance writes.',
        kind: 'fact',
        holder: 'self',
        weight: 0.9,
        sinceDate: '2026-07-01',
        source: 'slack:a,slack:b',
        active: true,
      }),
    ]);
  });

  test('semantic rerun preserves row identity and refreshes source', () => {
    const first = upsertConsolidatedTakeBody(
      '# Maestro\n',
      {
        claim: 'Maestro retries failed maintenance writes.',
        weight: 0.9,
        sinceDate: '2026-07-01',
        source: 'slack:a',
      },
      { preferredRowNum: 2 },
    );
    const second = upsertConsolidatedTakeBody(
      first.body,
      {
        claim: 'Maestro retries failed maintenance writes.',
        weight: 0.7,
        sinceDate: '2026-07-01',
        source: 'slack:a,slack:b',
      },
      { preferredRowNum: 9 },
    );

    expect(second.created).toBe(false);
    expect(second.rowNum).toBe(2);
    const parsed = parseTakesFence(second.body);
    expect(parsed.takes).toHaveLength(1);
    expect(parsed.takes[0].weight).toBe(0.9);
    expect(parsed.takes[0].source).toBe('slack:a,slack:b');
  });

  test('moves a semantic fence row away from an occupied DB row number', () => {
    const first = upsertConsolidatedTakeBody(
      '# Maestro\n',
      {
        claim: 'Maestro retries failed maintenance writes.',
        weight: 0.9,
        sinceDate: '2026-07-01',
        source: 'slack:a',
      },
      { preferredRowNum: 2 },
    );
    const repaired = upsertConsolidatedTakeBody(
      first.body,
      {
        claim: 'Maestro retries failed maintenance writes.',
        weight: 0.9,
        sinceDate: '2026-07-01',
        source: 'slack:a',
      },
      {
        preferredRowNum: 2,
        occupiedRowNums: new Set([2, 7]),
        maxKnownRowNum: 7,
      },
    );

    expect(repaired.rowNum).toBe(8);
    expect(parseTakesFence(repaired.body).takes.map(t => t.rowNum)).toEqual([8]);
  });
});
