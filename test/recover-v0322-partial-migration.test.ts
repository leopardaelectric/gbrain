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

const factMetadata = {
  kind: 'fact' as const,
  confidence: 1,
  visibility: 'private' as const,
  notability: 'medium' as const,
  validFrom: '2026-08-23',
  validUntil: undefined,
  context: undefined,
  active: true,
  claimMetric: undefined,
  claimValue: undefined,
  claimUnit: undefined,
  claimPeriod: undefined,
};

function dbRow(input: Partial<RecoveryDbRow> & Pick<RecoveryDbRow, 'id' | 'fact'>): RecoveryDbRow {
  return {
    source_id: 'mind-agent-brain',
    entity_slug: 'entities/alice',
    source: 'sync:import',
    kind: 'fact',
    confidence: 1,
    visibility: 'private',
    notability: 'medium',
    context: null,
    valid_from: '2026-08-23',
    valid_until: null,
    expired_at: null,
    claim_metric: null,
    claim_value: null,
    claim_unit: null,
    claim_period: null,
    row_num: null,
    source_markdown_slug: null,
    ...input,
  };
}

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
      let laterAlice = page('entities/alice', ['Existing', 'Added to existing', 'Later legitimate fact']);
      laterAlice = upsertFactRow(laterAlice, {
        claim: 'Added to existing',
        kind: 'fact',
        confidence: 1,
        visibility: 'private',
        notability: 'medium',
        validFrom: '2026-08-24',
        source: 'sync:import',
        context: 'later independent observation',
      }).body;
      writeFileSync(join(repo, 'entities/alice.md'), laterAlice, 'utf-8');
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
        'Added to existing',
      ]);
      expect(parseFactsFence(fileRecovery.rewrites[0]!.body).facts.at(-1)).toMatchObject({
        validFrom: '2026-08-24',
        context: 'later independent observation',
      });
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
      { pageSlug: 'root-ghost', rowNum: 1, claim: 'Added ghost', source: 'sync:import', ...factMetadata },
      { pageSlug: 'entities/alice', rowNum: 2, claim: 'Added to existing', source: 'sync:import', ...factMetadata },
    ],
  };

  test('resets migrated originals and deletes exact retry duplicates', () => {
    const rows: RecoveryDbRow[] = [
      dbRow({
        id: '1', entity_slug: 'root-ghost', fact: 'Added ghost', source: 'sync:import',
        row_num: 1, source_markdown_slug: 'root-ghost',
      }),
      dbRow({
        id: '10', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: null, source_markdown_slug: null,
      }),
      dbRow({
        id: '20', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 2, source_markdown_slug: 'entities/alice',
      }),
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['1']);
    expect(plan.deleteDuplicateIds).toEqual(['20']);
    expect(plan.alreadyLegacy).toEqual(['10']);
  });

  test('preserves later facts that landed in a page created by the bad migration', () => {
    const rows: RecoveryDbRow[] = [
      dbRow({
        id: '99', entity_slug: 'root-ghost', fact: 'Different fact', source: 'sync:import',
        row_num: 84, source_markdown_slug: 'root-ghost',
      }),
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['99']);
  });

  test('matches modified-page recovery by content when row numbers drift', () => {
    const rows: RecoveryDbRow[] = [
      dbRow({
        id: '30', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 84, source_markdown_slug: 'entities/alice',
      }),
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual(['30']);
  });

  test('refuses duplicate matching occupants on a modified page', () => {
    const rows: RecoveryDbRow[] = [
      dbRow({
        id: '30', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 84, source_markdown_slug: 'entities/alice',
      }),
      dbRow({
        id: '31', entity_slug: 'entities/alice', fact: 'Added to existing', source: 'sync:import',
        row_num: 85, source_markdown_slug: 'entities/alice',
      }),
    ];

    expect(() => classifyRecoveryRows(manifest, rows)).toThrow('multiple matching fenced rows');
  });

  test('preserves facts with the same claim and source but different metadata', () => {
    const rows: RecoveryDbRow[] = [
      dbRow({
        id: '30', fact: 'Added to existing', row_num: 84,
        source_markdown_slug: 'entities/alice', valid_from: '2026-08-24',
      }),
      dbRow({
        id: '31', fact: 'Added to existing', row_num: 85,
        source_markdown_slug: 'entities/alice', context: 'later independent observation',
      }),
    ];

    const plan = classifyRecoveryRows(manifest, rows);

    expect(plan.resetIds).toEqual([]);
    expect(plan.deleteDuplicateIds).toEqual([]);
  });
});
