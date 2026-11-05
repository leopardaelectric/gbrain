import { expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { findMisroutedPages } from '../../src/core/multi-source-drift.ts';

/** Shared real-engine checks. All rows and files are synthetic test fixtures. */
export async function checkDriftSourceIsolation(engine: BrainEngine): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-drift-isolation-'));
  const source = `drift-${Date.now()}`;
  const other = `${source}-other`;
  const folder = `drift-fixture-${Date.now()}`;
  const slugs = ['misroute', 'healthy', 'foreign-only', 'deleted-default', 'deleted-intended', 'missing']
    .map(leaf => `${folder}/${leaf}`);
  try {
    mkdirSync(join(root, folder));
    for (const slug of slugs) writeFileSync(join(root, `${slug}.md`), '# Fixture\n');
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1), ($2, $2)', [source, other]);
    const page = { type: 'concept', title: 'Synthetic fixture', compiled_truth: '.' };
    for (const leaf of ['misroute', 'healthy', 'deleted-default', 'deleted-intended']) {
      await engine.putPage(`${folder}/${leaf}`, page, { sourceId: 'default' });
    }
    await engine.putPage(`${folder}/healthy`, page, { sourceId: source });
    await engine.putPage(`${folder}/deleted-intended`, page, { sourceId: source });
    await engine.putPage(`${folder}/foreign-only`, page, { sourceId: other });
    // A foreign source must not hide a real default-only misroute.
    await engine.putPage(`${folder}/misroute`, page, { sourceId: other });
    await engine.executeRaw('UPDATE pages SET deleted_at = NOW() WHERE (source_id = $1 AND slug = $2) OR (source_id = $3 AND slug = $4)',
      ['default', `${folder}/deleted-default`, source, `${folder}/deleted-intended`]);
    const result = await findMisroutedPages(engine, [{ id: source, local_path: root }]);
    expect(result.walk_truncated).toBe(false);
    expect(result.count).toBe(2);
    expect(result.sample.map(row => row.slug).sort()).toEqual([`${folder}/deleted-intended`, `${folder}/misroute`]);
    expect(result.sample.every(row => row.intended_source === source)).toBe(true);
    // Existence at a second intended source must be evaluated separately.
    const second = await findMisroutedPages(engine, [{ id: other, local_path: root }]);
    expect(second.count).toBe(2);
    expect(second.sample.map(row => row.slug).sort()).toEqual([`${folder}/deleted-intended`, `${folder}/healthy`]);
  } finally {
    await engine.executeRaw('DELETE FROM pages WHERE slug = ANY($1::text[])', [slugs]);
    await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[source, other]]);
    rmSync(root, { recursive: true, force: true });
  }
}

export async function checkLargeDriftProbe(engine: BrainEngine): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-drift-large-'));
  const total = 65_536; // Above the wire protocol's bind-parameter limit.
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  // A narrow forwarding wrapper records the actual SQL without global mocks.
  const probeEngine = {
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      statements.push({ sql, params: params ?? [] });
      return engine.executeRaw<T>(sql, params);
    },
  } as BrainEngine;
  try {
    for (let i = 0; i < total; i++) writeFileSync(join(root, `large-${i}.md`), '');
    const result = await findMisroutedPages(probeEngine, [{ id: 'drift-large-empty', local_path: root }],
      { limit: total + 1, timeoutMs: 120_000 });
    expect(result).toEqual({ count: 0, sample: [], walk_truncated: false });
    expect(statements).toHaveLength(1);
    expect(statements[0].params).toHaveLength(2);
    expect(statements[0].params[0]).toHaveLength(total);
    expect(statements[0].params[1]).toBe('drift-large-empty');
    expect(statements[0].sql).toContain('unnest($1::text[])');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
