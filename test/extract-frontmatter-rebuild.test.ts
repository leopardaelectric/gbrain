import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { setCliOptions } from '../src/core/cli-options.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

async function companyLinks(): Promise<Array<{ to_slug: string; link_source: string | null }>> {
  return engine.executeRaw(
    `SELECT t.slug AS to_slug, l.link_source
     FROM links l
     JOIN pages f ON f.id = l.from_page_id
     JOIN pages t ON t.id = l.to_page_id
     WHERE f.slug = 'people/alice' AND l.link_type = 'works_at'
     ORDER BY l.link_source`,
    [],
  );
}

describe('extract links --include-frontmatter reconciliation', () => {
  test('removes a stale frontmatter edge and preserves another provenance', async () => {
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'Acme', timeline: '', frontmatter: {},
    });
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: 'Alice', timeline: '',
      frontmatter: { company: 'companies/acme' },
    });

    await runExtract(engine, ['links', '--source', 'db', '--include-frontmatter']);
    expect(await companyLinks()).toEqual([{ to_slug: 'companies/acme', link_source: 'frontmatter' }]);

    await engine.addLink('people/alice', 'companies/acme', 'directory proof', 'works_at', 'vammo-people-directory');
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: 'Alice', timeline: '', frontmatter: {},
    }, { allowEmptyOverwrite: true });

    await runExtract(engine, ['links', '--source', 'db', '--include-frontmatter']);
    expect(await companyLinks()).toEqual([
      { to_slug: 'companies/acme', link_source: 'vammo-people-directory' },
    ]);
  });

  test('removes a stale incoming edge by the page that authored it', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: 'Alice', timeline: '', frontmatter: {},
    });
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'Acme', timeline: '',
      frontmatter: { key_people: ['people/alice'] },
    });

    await runExtract(engine, ['links', '--source', 'db', '--include-frontmatter', '--type', 'company']);
    expect(await companyLinks()).toEqual([{ to_slug: 'companies/acme', link_source: 'frontmatter' }]);

    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'Acme', timeline: '', frontmatter: {},
    }, { allowEmptyOverwrite: true });
    await runExtract(engine, ['links', '--source', 'db', '--include-frontmatter', '--type', 'company']);
    expect(await companyLinks()).toEqual([]);
  });
});
