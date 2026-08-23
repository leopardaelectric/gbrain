import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';

import {
  FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable,
} from '../src/core/facts-fence.ts';
import type { BrainEngine } from '../src/core/engine.ts';

export interface RecoveryFactCoordinate {
  pageSlug: string;
  rowNum: number;
  claim: string;
  source: string;
}

export interface RecoveryManifest {
  commit: string;
  addedPages: string[];
  modifiedPages: string[];
  facts: RecoveryFactCoordinate[];
}

export interface RecoveryDbRow {
  id: string;
  entity_slug: string | null;
  fact: string;
  source: string;
  row_num: number | null;
  source_markdown_slug: string | null;
}

export interface RecoveryPlan {
  resetIds: string[];
  deleteDuplicateIds: string[];
  alreadyLegacy: string[];
}

export interface FileRecovery {
  deletePaths: string[];
  rewrites: Array<{ path: string; body: string }>;
}

/** Derive the exact pages and fence rows introduced by one migration commit. */
export function buildRecoveryManifest(repoPath: string, revision: string): RecoveryManifest {
  const commit = git(repoPath, ['rev-parse', `${revision}^{commit}`]).trim();
  const parent = git(repoPath, ['rev-parse', `${commit}^`]).trim();
  const changed = git(repoPath, [
    '-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--name-status',
    '-r', '--diff-filter=AM', commit,
  ]).trim();

  const addedPages: string[] = [];
  const modifiedPages: string[] = [];
  const facts: RecoveryFactCoordinate[] = [];

  for (const line of changed ? changed.split('\n') : []) {
    const tab = line.indexOf('\t');
    if (tab === -1) throw new Error(`unparseable git diff entry: ${line}`);
    const status = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if (!path.endsWith('.md')) {
      throw new Error(`target commit contains a non-markdown ${status} path: ${path}`);
    }

    const newFence = parseFactsFence(git(repoPath, ['show', `${commit}:${path}`]));
    if (newFence.warnings.length > 0) {
      throw new Error(`${path}: invalid new facts fence: ${newFence.warnings.join('; ')}`);
    }
    const oldFacts = status === 'A'
      ? []
      : parseFactsFence(git(repoPath, ['show', `${parent}:${path}`])).facts;
    const oldKeys = new Set(oldFacts.map(factKey));
    const addedFacts = newFence.facts.filter(f => !oldKeys.has(factKey(f)));
    if (addedFacts.length === 0) {
      throw new Error(`${path}: target commit changed markdown without adding a facts-fence row`);
    }

    if (status === 'A') addedPages.push(path);
    else if (status === 'M') modifiedPages.push(path);
    else throw new Error(`unsupported git status ${status} for ${path}`);

    const pageSlug = path.slice(0, -'.md'.length);
    for (const fact of addedFacts) {
      facts.push({
        pageSlug,
        rowNum: fact.rowNum,
        claim: fact.claim,
        source: fact.source ?? '',
      });
    }
  }

  addedPages.sort();
  modifiedPages.sort();
  facts.sort((a, b) => a.pageSlug.localeCompare(b.pageSlug) || a.rowNum - b.rowNum);
  return { commit, addedPages, modifiedPages, facts };
}

/**
 * Build cleanup edits against the current tree, not the historical commit.
 * This preserves facts appended after the bad migration: whole ghost pages
 * are removed after their DB rows become legacy, while legitimate pages lose
 * only the claim/source rows introduced by the target commit.
 */
export function buildFileRecovery(repoPath: string, manifest: RecoveryManifest): FileRecovery {
  const deletePaths = manifest.addedPages.filter(path => existsSync(`${repoPath}/${path}`));
  const rewrites: Array<{ path: string; body: string }> = [];
  const factsByPage = new Map<string, Set<string>>();
  for (const fact of manifest.facts) {
    const keys = factsByPage.get(fact.pageSlug) ?? new Set<string>();
    keys.add(contentKey(fact.claim, fact.source));
    factsByPage.set(fact.pageSlug, keys);
  }

  for (const path of manifest.modifiedPages) {
    const filePath = `${repoPath}/${path}`;
    if (!existsSync(filePath)) throw new Error(`modified recovery page is missing: ${path}`);
    const body = readFileSync(filePath, 'utf-8');
    const parsed = parseFactsFence(body);
    if (parsed.warnings.length > 0) {
      throw new Error(`${path}: invalid current facts fence: ${parsed.warnings.join('; ')}`);
    }
    const pageSlug = path.slice(0, -'.md'.length);
    const targetKeys = factsByPage.get(pageSlug) ?? new Set<string>();
    const remaining = parsed.facts.filter(f => !targetKeys.has(contentKey(f.claim, f.source ?? '')));
    if (remaining.length === parsed.facts.length) continue;

    const begin = body.indexOf(FACTS_FENCE_BEGIN);
    const end = body.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
    if (begin === -1 || end === -1) throw new Error(`${path}: facts fence disappeared during recovery`);
    const recovered = body.slice(0, begin) + renderFactsTable(remaining) +
      body.slice(end + FACTS_FENCE_END.length);
    rewrites.push({ path, body: recovered });
  }

  return {
    deletePaths: deletePaths.sort(),
    rewrites: rewrites.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Decide which fact rows to preserve as legacy and which retry duplicates to remove. */
export function classifyRecoveryRows(
  manifest: RecoveryManifest,
  rows: RecoveryDbRow[],
): RecoveryPlan {
  const resetIds: string[] = [];
  const deleteDuplicateIds: string[] = [];
  const alreadyLegacy: string[] = [];

  // Every current fact indexed to a page CREATED by the bad migration must
  // survive page deletion. Group exact duplicates so one canonical legacy row
  // remains even when later sync retries indexed the same claim more than once.
  const addedSlugs = new Set(manifest.addedPages.map(path => path.slice(0, -'.md'.length)));
  const addedGroups = new Map<string, RecoveryDbRow[]>();
  for (const row of rows) {
    if (!row.source_markdown_slug || !addedSlugs.has(row.source_markdown_slug) || row.row_num === null) continue;
    const key = `${row.source_markdown_slug}\0${contentKey(row.fact, row.source)}`;
    const group = addedGroups.get(key) ?? [];
    group.push(row);
    addedGroups.set(key, group);
  }
  for (const occupants of addedGroups.values()) {
    occupants.sort(compareIds);
    const first = occupants[0]!;
    const legacies = matchingLegacyRows(rows, first.source_markdown_slug!, first.fact, first.source);
    if (legacies.length > 1) {
      throw new Error(`${first.source_markdown_slug}: multiple matching legacy rows for ${first.id}`);
    }
    if (legacies.length === 1) {
      deleteDuplicateIds.push(...occupants.map(row => row.id));
      alreadyLegacy.push(legacies[0]!.id);
    } else {
      resetIds.push(first.id);
      deleteDuplicateIds.push(...occupants.slice(1).map(row => row.id));
    }
  }

  // Legitimate modified pages can have received later rows and row-number
  // changes. Match the bad migration's rows by page + claim + source, never by
  // the stale historical row number.
  const modifiedSlugs = new Set(manifest.modifiedPages.map(path => path.slice(0, -'.md'.length)));
  const modifiedTargets = new Map<string, RecoveryFactCoordinate>();
  for (const fact of manifest.facts) {
    if (modifiedSlugs.has(fact.pageSlug)) {
      modifiedTargets.set(`${fact.pageSlug}\0${contentKey(fact.claim, fact.source)}`, fact);
    }
  }
  for (const fact of modifiedTargets.values()) {
    const occupants = rows.filter(row =>
      row.source_markdown_slug === fact.pageSlug &&
      row.row_num !== null &&
      row.fact === fact.claim &&
      row.source === fact.source,
    );
    occupants.sort(compareIds);
    const legacies = matchingLegacyRows(rows, fact.pageSlug, fact.claim, fact.source);
    if (legacies.length > 1) {
      throw new Error(`${fact.pageSlug}: multiple matching legacy rows for ${fact.claim}`);
    }
    if (occupants.length > 0 && legacies.length === 1) {
      deleteDuplicateIds.push(...occupants.map(row => row.id));
      alreadyLegacy.push(legacies[0]!.id);
    } else if (occupants.length > 0) {
      resetIds.push(occupants[0]!.id);
      deleteDuplicateIds.push(...occupants.slice(1).map(row => row.id));
    } else if (legacies.length === 1) {
      alreadyLegacy.push(legacies[0]!.id);
    }
    // Neither exists: a later edit already removed the historical fact.
  }

  return {
    resetIds: [...new Set(resetIds)],
    deleteDuplicateIds: [...new Set(deleteDuplicateIds)],
    alreadyLegacy: [...new Set(alreadyLegacy)],
  };
}

function matchingLegacyRows(
  rows: RecoveryDbRow[], pageSlug: string, claim: string, source: string,
): RecoveryDbRow[] {
  return rows.filter(row =>
    row.row_num === null && row.entity_slug === pageSlug &&
    row.fact === claim && row.source === source,
  );
}

function compareIds(a: RecoveryDbRow, b: RecoveryDbRow): number {
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function factKey(fact: { rowNum: number; claim: string; source?: string }): string {
  return `${fact.rowNum}\0${fact.claim}\0${fact.source ?? ''}`;
}

function contentKey(claim: string, source: string): string {
  return `${claim}\0${source}`;
}

async function loadRecoveryRows(
  engine: BrainEngine,
  sourceId: string,
  manifest: RecoveryManifest,
): Promise<RecoveryDbRow[]> {
  const slugs = [...new Set([
    ...manifest.addedPages.map(path => path.slice(0, -'.md'.length)),
    ...manifest.modifiedPages.map(path => path.slice(0, -'.md'.length)),
  ])];
  if (slugs.length === 0) return [];
  return engine.executeRaw<RecoveryDbRow>(
    `SELECT id::text, entity_slug, fact, source, row_num, source_markdown_slug
       FROM facts
      WHERE source_id = $1
        AND (
          (source_markdown_slug = ANY($2::text[]) AND row_num IS NOT NULL)
          OR
          (entity_slug = ANY($2::text[]) AND row_num IS NULL)
        )`,
    [sourceId, slugs],
  );
}

async function recoverDatabase(
  engine: BrainEngine,
  sourceId: string,
  manifest: RecoveryManifest,
  write: boolean,
): Promise<RecoveryPlan> {
  const preview = classifyRecoveryRows(manifest, await loadRecoveryRows(engine, sourceId, manifest));
  if (!write) return preview;

  return engine.transaction(async tx => {
    const plan = classifyRecoveryRows(manifest, await loadRecoveryRows(tx, sourceId, manifest));
    for (const id of plan.deleteDuplicateIds) {
      await tx.executeRaw(`DELETE FROM facts WHERE id = $1`, [id]);
    }
    for (const id of plan.resetIds) {
      await tx.executeRaw(
        `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL WHERE id = $1`,
        [id],
      );
    }
    return plan;
  });
}

interface CliArgs {
  repo: string;
  commit: string;
  source: string;
  write: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const read = (name: string): string => {
    const index = argv.indexOf(name);
    const value = index === -1 ? undefined : argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing required ${name}`);
    return value;
  };
  return {
    repo: read('--repo'),
    commit: read('--commit'),
    source: read('--source'),
    write: argv.includes('--write'),
  };
}

function assertRecoveryPathsClean(repo: string, files: FileRecovery): void {
  const paths = [...files.deletePaths, ...files.rewrites.map(item => item.path)];
  if (paths.length === 0) return;
  const status = git(repo, ['status', '--porcelain=v1', '--', ...paths]);
  if (status.trim()) throw new Error('recovery target paths have uncommitted changes');
}

function applyFileRecovery(repo: string, files: FileRecovery): void {
  for (const item of files.rewrites) {
    const filePath = `${repo}/${item.path}`;
    const tmpPath = `${filePath}.v0322-recovery.tmp`;
    writeFileSync(tmpPath, item.body, 'utf-8');
    renameSync(tmpPath, filePath);
  }
  for (const path of files.deletePaths) unlinkSync(`${repo}/${path}`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const repo = realpathSync(args.repo);
  const manifest = buildRecoveryManifest(repo, args.commit);
  const files = buildFileRecovery(repo, manifest);
  assertRecoveryPathsClean(repo, files);

  const { loadConfig, toEngineConfig } = await import('../src/core/config.ts');
  const { createEngine } = await import('../src/core/engine-factory.ts');
  const config = loadConfig();
  if (!config) throw new Error('no gbrain configuration found');
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources WHERE id = $1`,
      [args.source],
    );
    const source = sources[0];
    if (!source) throw new Error(`source not found: ${args.source}`);
    if (!source.local_path || realpathSync(source.local_path) !== repo) {
      throw new Error(`source ${args.source} local_path does not match --repo`);
    }

    const plan = await recoverDatabase(engine, args.source, manifest, args.write);
    if (args.write) applyFileRecovery(repo, files);
    console.log(JSON.stringify({
      mode: args.write ? 'write' : 'dry-run',
      source: args.source,
      commit: manifest.commit,
      added_pages: manifest.addedPages.length,
      modified_pages: manifest.modifiedPages.length,
      added_fence_rows: manifest.facts.length,
      files_deleted: files.deletePaths.length,
      files_rewritten: files.rewrites.length,
      reset_rows: plan.resetIds.length,
      deleted_retry_duplicates: plan.deleteDuplicateIds.length,
      already_legacy_rows: plan.alreadyLegacy.length,
    }, null, 2));
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
