import { describe, expect, it } from 'bun:test';
import { randomUUIDv7 } from '../src/core/uuid.ts';

describe('portable UUIDv7', () => {
  it('preserves the version, variant, timestamp and random identifier contract', () => {
    const before = Date.now();
    const ids = Array.from({ length: 1000 }, () => randomUUIDv7());
    const after = Date.now();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const timestamp = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    }
  });
});
