import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import {
  buildRecoveryManifest,
  buildFileRecovery,
  classifyRecoveryRows,
  type RecoveryDbRow,
  type RecoveryManifest,
} from '../scripts/recover-v0322-partial-migration.ts';

function page(slug: string, facts: string[]): string {
  let body = `---\ntype: concept\ntitle: ${slug}\nslug: ${slug}\n---\n\n# ${slug}\n`;
  for (const fact of facts) {
    body = upsertFactRow(body, {
      claim: fact,
      kind: 'fact',
      confidence: 1,
      visibility: 'private',
      notability: 'medium',
      validFrom: '2026-08-23',
      source: 'sync:import',
    }).body;
  }
  return body;
}

describe('buildRecoveryManifest', () => {
  test('derives only fence rows added by the target commit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'v0322-recovery-git-'));
    try {
      execFileSync('git', ['-C', repo, 'init', '-q']);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
      mkdirSync(join(repo, 'entities'), { recursive: true });
      writeFileSync(join(repo, 'entities/alice.md'), page('entities/alice', ['Existing']), 'utf-8');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);

      writeFileSync(
        join(repo, 'entities/alice.md'),
        page('entities/alice', ['Existing', 'Added to existing']),
        'utf-8',
      );
      writeFileSync(join(repo, 'root-ghost.md'), page('root-ghost', ['Added ghost']), 'utf-8');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'partial migration']);
      const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

      // Later writes must survive recovery even though the original partial
      // migration commit is no longer the tip.
      writeFileSync(
        join(repo, 'entities/alice.md'),
        page('entities/alice', ['Existing', 'Added to existing', 'Later legitimate fact']),
        'utf-8',
      );
      writeFileSync(
        join(repo, 'root-ghost.md'),
        page('root-ghost', ['Added ghost', 'Later fact trapped in ghost page']),
        'utf-8',
      );
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'later writes']);

      const manifest = buildRecoveryManifest(repo, commit);

      expect(manifest.addedPages).toEqual(['root-ghost.md']);
      expect(manifest.modifiedPages).toEqual(['entities/alice.md']);
      expect(manifest.facts.map(f => [f.pageSlug, f.rowNum, f.claim])).toEqual([
        ['entities/alice', 2, 'Added to existing'],
        ['root-ghost', 1, 'Added ghost'],
      ]);

      const fileRecovery = buildFileRecovery(repo, manifest);
      expect(fileRecovery.deletePaths).toEqual(['root-ghost.md']);
      expect(fileRecovery.rewrites).toHaveLength(1);
      expect(fileRecovery.rewrites[0]!.path).toBe('entities/alice.md');
      expect(parseFactsFence(fileRecovery.rewrites[0]!.body).facts.map(f => f.claim)).toEqual([
        'Existing',
        'Later legitimate fact',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classifyRecoveryRows', () => {
  const manifest: RecoveryManifest = {
    commit: 'abc123',
    addedPages: ['root-ghost.md'],
    modifiedPages: ['entities/alice.md'],
    facts: [
      { pageSlug: 'root-ghost', rowNum: 1, claim: 'Added ghost', source: 'sync:import' },
      { pageSlug: 'entities/alice', rowNum: 2, claim: 'Added to existing', source: 'sync:import' },
    ],
  };

  test('resets migrated originals and deletes exact retry duplicates', () => {
    const rows: RecoveryDbRow[] = [
      {
        id: '1', entity_slug: 'root-ghost', fact: 'Added ghost', source: 'sync:import',
        row_num: 1, source_markdown_slug: 'root-ghost',
      },
      {
        id: '10', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: null, source_markdown_slug: null,
      },
      {
        id: '20', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 2, source_markdown_slug: 'entities/alice',
      },
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['1']);
    expect(plan.deleteDuplicateIds).toEqual(['20']);
    expect(plan.alreadyLegacy).toEqual(['10']);
  });

  test('preserves later facts that landed in a page created by the bad migration', () => {
    const rows: RecoveryDbRow[] = [
      {
        id: '99', entity_slug: 'root-ghost', fact: 'Different fact', source: 'sync:import',
        row_num: 84, source_markdown_slug: 'root-ghost',
      },
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['99']);
  });

  test('matches modified-page recovery by content when row numbers drift', () => {
    const rows: RecoveryDbRow[] = [
      {
        id: '30', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 84, source_markdown_slug: 'entities/alice',
      },
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['30']);
  });

  test('consolidates duplicate matching occupants on a modified page', () => {
    const rows: RecoveryDbRow[] = [
      {
        id: '30', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 84, source_markdown_slug: 'entities/alice',
      },
      {
        id: '31', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 85, source_markdown_slug: 'entities/alice',
      },
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['30']);
    expect(plan.deleteDuplicateIds).toEqual(['31']);
  });
});
