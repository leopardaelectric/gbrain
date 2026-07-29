import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { writeExtractedTakesToPage } from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-extracted-takes-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('writeExtractedTakesToPage', () => {
  test('writes Markdown before mirroring extracted takes to DB and deduplicates reruns', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title)
       VALUES ('topics/bootstrap', 'concept', 'Bootstrap')`,
    );
    const [page] = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'topics/bootstrap'`,
    );
    const filePath = join(brainDir, 'topics/bootstrap.md');
    mkdirSync(join(brainDir, 'topics'), { recursive: true });
    writeFileSync(filePath, '# Bootstrap\n');

    const target = {
      localPath: brainDir,
      pageId: page.id,
      slug: 'topics/bootstrap',
      holder: 'system',
    };
    const claims = [
      { claim: 'Bootstrap claims must survive DB rebuilds.', kind: 'take', weight: 0.8 },
      { claim: 'Markdown is canonical.', kind: 'fact', weight: 1 },
    ];

    expect(await writeExtractedTakesToPage(engine, target, claims)).toBe(2);
    expect(await writeExtractedTakesToPage(engine, target, claims)).toBe(0);

    const parsed = parseTakesFence(await Bun.file(filePath).text());
    expect(parsed.warnings).toEqual([]);
    expect(parsed.takes.map(t => t.claim)).toEqual(claims.map(c => c.claim));
    const rows = await engine.executeRaw<{ claim: string }>(
      `SELECT claim FROM takes WHERE page_id = $1 ORDER BY row_num`,
      [page.id],
    );
    expect(rows.map(row => row.claim)).toEqual(claims.map(c => c.claim));
  });
});
