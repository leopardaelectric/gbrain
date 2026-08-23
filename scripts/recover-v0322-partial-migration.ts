import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';

import {
  FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable,
} from '../src/core/facts-fence.ts';
import type { FactKind, FactNotability, FactVisibility, ParsedFact } from '../src/core/facts-fence.ts';
import type { BrainEngine } from '../src/core/engine.ts';

export interface RecoveryFactCoordinate {
  pageSlug: string;
  rowNum: number;
  claim: string;
  source: string;
  kind: FactKind;
  confidence: number;
  visibility: FactVisibility;
  notability: FactNotability;
  validFrom?: string;
  validUntil?: string;
  context?: string;
  active: boolean;
  claimMetric?: string;
  claimValue?: number;
  claimUnit?: string;
  claimPeriod?: string;
}

export interface RecoveryManifest {
  commit: string;
  addedPages: string[];
  modifiedPages: string[];
  facts: RecoveryFactCoordinate[];
}

export interface RecoveryDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  source: string;
  kind: FactKind;
  confidence: number;
  visibility: FactVisibility;
  notability: FactNotability;
  context: string | null;
  valid_from: string | Date;
  valid_until: string | Date | null;
  expired_at: string | Date | null;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
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
        kind: fact.kind,
        confidence: fact.confidence,
        visibility: fact.visibility,
        notability: fact.notability,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        context: fact.context,
        active: fact.active,
        claimMetric: fact.claimMetric,
        claimValue: fact.claimValue,
        claimUnit: fact.claimUnit,
        claimPeriod: fact.claimPeriod,
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
 * only the full-metadata rows introduced by the target commit.
 */
export function buildFileRecovery(repoPath: string, manifest: RecoveryManifest): FileRecovery {
  const deletePaths = manifest.addedPages.filter(path => existsSync(`${repoPath}/${path}`));
  const rewrites: Array<{ path: string; body: string }> = [];
  const factsByPage = new Map<string, RecoveryFactCoordinate[]>();
  for (const fact of manifest.facts) {
    const targets = factsByPage.get(fact.pageSlug) ?? [];
    targets.push(fact);
    factsByPage.set(fact.pageSlug, targets);
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
    const targets = factsByPage.get(pageSlug) ?? [];
    const targetKeys = new Set<string>();
    const removeRowNums = new Set<number>();
    for (const target of targets) {
      const key = factContentKey(target);
      if (targetKeys.has(key)) {
        throw new Error(`${path}: target commit contains ambiguous duplicate fact metadata`);
      }
      targetKeys.add(key);
      const matches = parsed.facts.filter(f => factContentKey(f) === key);
      if (matches.length > 1) {
        throw new Error(`${path}: multiple current fence rows match target fact metadata`);
      }
      if (matches.length === 1) removeRowNums.add(matches[0]!.rowNum);
    }
    const remaining = parsed.facts.filter(f => !removeRowNums.has(f.rowNum));
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
  // survive page deletion. Full fence metadata is part of fact identity: a
  // later observation with the same claim/source but a different date,
  // context, visibility, or typed value is independent data.
  const addedSlugs = new Set(manifest.addedPages.map(path => path.slice(0, -'.md'.length)));
  const addedGroups = new Map<string, RecoveryDbRow[]>();
  for (const row of rows) {
    if (!row.source_markdown_slug || !addedSlugs.has(row.source_markdown_slug) || row.row_num === null) continue;
    const key = `${row.source_markdown_slug}\0${factContentKey(dbFact(row))}`;
    const group = addedGroups.get(key) ?? [];
    group.push(row);
    addedGroups.set(key, group);
  }
  for (const occupants of addedGroups.values()) {
    occupants.sort(compareIds);
    const first = occupants[0]!;
    const legacies = matchingLegacyRows(rows, first.source_markdown_slug!, dbFact(first));
    if (legacies.length > 1) {
      throw new Error(`${first.source_markdown_slug}: multiple matching legacy rows for ${first.id}`);
    }
    if (occupants.length === 1 && legacies.length === 1) {
      deleteDuplicateIds.push(first.id);
      alreadyLegacy.push(legacies[0]!.id);
    } else {
      // Multiple identical occupants are indistinguishable: reset all instead
      // of guessing that one is a retry duplicate. This can preserve a benign
      // duplicate, but cannot delete a later legitimate fact.
      resetIds.push(...occupants.map(row => row.id));
      if (legacies.length === 1) alreadyLegacy.push(legacies[0]!.id);
    }
  }

  // Legitimate modified pages can have received later rows and row-number
  // changes. Match the bad migration's rows by page + claim + source, never by
  // the stale historical row number.
  const modifiedSlugs = new Set(manifest.modifiedPages.map(path => path.slice(0, -'.md'.length)));
  const modifiedTargets = new Map<string, RecoveryFactCoordinate>();
  for (const fact of manifest.facts) {
    if (modifiedSlugs.has(fact.pageSlug)) {
      const key = `${fact.pageSlug}\0${factContentKey(fact)}`;
      if (modifiedTargets.has(key)) {
        throw new Error(`${fact.pageSlug}: target commit contains ambiguous duplicate fact metadata`);
      }
      modifiedTargets.set(key, fact);
    }
  }
  for (const fact of modifiedTargets.values()) {
    const occupants = rows.filter(row =>
      row.source_markdown_slug === fact.pageSlug &&
      row.row_num !== null &&
      factContentKey(dbFact(row)) === factContentKey(fact),
    );
    occupants.sort(compareIds);
    if (occupants.length > 1) {
      throw new Error(`${fact.pageSlug}: multiple matching fenced rows for ${fact.claim}`);
    }
    const legacies = matchingLegacyRows(rows, fact.pageSlug, fact);
    if (legacies.length > 1) {
      throw new Error(`${fact.pageSlug}: multiple matching legacy rows for ${fact.claim}`);
    }
    if (occupants.length === 1 && legacies.length === 1) {
      deleteDuplicateIds.push(occupants[0]!.id);
      alreadyLegacy.push(legacies[0]!.id);
    } else if (occupants.length === 1) {
      resetIds.push(occupants[0]!.id);
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
  rows: RecoveryDbRow[], pageSlug: string, fact: FactIdentity,
): RecoveryDbRow[] {
  return rows.filter(row =>
    row.row_num === null && row.entity_slug === pageSlug &&
    factContentKey(dbFact(row)) === factContentKey(fact),
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

function factKey(fact: ParsedFact): string {
  return `${fact.rowNum}\0${factContentKey(fact)}`;
}

type FactIdentity = Omit<RecoveryFactCoordinate, 'pageSlug' | 'rowNum'>;

function factContentKey(fact: FactIdentity | ParsedFact): string {
  return JSON.stringify([
    fact.claim,
    fact.source ?? '',
    fact.kind,
    Number(fact.confidence),
    fact.visibility,
    fact.notability,
    fact.validFrom ?? '',
    fact.validUntil ?? '',
    fact.context ?? '',
    fact.active,
    fact.claimMetric ?? '',
    fact.claimValue ?? '',
    fact.claimUnit ?? '',
    fact.claimPeriod ?? '',
  ]);
}

function normalizeDate(value: string | Date | null): string | undefined {
  if (value === null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function dbFact(row: RecoveryDbRow): FactIdentity {
  return {
    claim: row.fact,
    source: row.source,
    kind: row.kind,
    confidence: Number(row.confidence),
    visibility: row.visibility,
    notability: row.notability,
    validFrom: normalizeDate(row.valid_from),
    validUntil: normalizeDate(row.valid_until),
    context: row.context ?? undefined,
    active: row.expired_at === null,
    claimMetric: row.claim_metric ?? undefined,
    claimValue: row.claim_value === null ? undefined : Number(row.claim_value),
    claimUnit: row.claim_unit ?? undefined,
    claimPeriod: row.claim_period ?? undefined,
  };
}

async function loadRecoveryRows(
  engine: BrainEngine,
  sourceId: string,
  manifest: RecoveryManifest,
  forUpdate = false,
): Promise<RecoveryDbRow[]> {
  const slugs = [...new Set([
    ...manifest.addedPages.map(path => path.slice(0, -'.md'.length)),
    ...manifest.modifiedPages.map(path => path.slice(0, -'.md'.length)),
  ])];
  if (slugs.length === 0) return [];
  return engine.executeRaw<RecoveryDbRow>(
    `SELECT id::text, source_id, entity_slug, fact, source, kind, confidence,
            visibility, notability, context, valid_from, valid_until, expired_at,
            claim_metric, claim_value, claim_unit, claim_period,
            row_num, source_markdown_slug
       FROM facts
      WHERE source_id = $1
        AND (
          (source_markdown_slug = ANY($2::text[]) AND row_num IS NOT NULL)
          OR
          (entity_slug = ANY($2::text[]) AND row_num IS NULL)
        )
      ${forUpdate ? 'FOR UPDATE' : ''}`,
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
    const lockedRows = await loadRecoveryRows(tx, sourceId, manifest, true);
    const plan = classifyRecoveryRows(manifest, lockedRows);
    const rowById = new Map(lockedRows.map(row => [row.id, row]));
    for (const id of plan.deleteDuplicateIds) {
      const row = rowById.get(id)!;
      const changed = await tx.executeRaw<{ id: string }>(
        `DELETE FROM facts
          WHERE id = $1 AND source_id = $2
            AND row_num IS NOT DISTINCT FROM $3
            AND source_markdown_slug IS NOT DISTINCT FROM $4
            AND fact = $5 AND source = $6
        RETURNING id::text`,
        [row.id, sourceId, row.row_num, row.source_markdown_slug, row.fact, row.source],
      );
      if (changed.length !== 1) throw new Error(`fact ${id} changed after recovery classification`);
    }
    for (const id of plan.resetIds) {
      const row = rowById.get(id)!;
      const changed = await tx.executeRaw<{ id: string }>(
        `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
          WHERE id = $1 AND source_id = $2
            AND row_num IS NOT DISTINCT FROM $3
            AND source_markdown_slug IS NOT DISTINCT FROM $4
            AND fact = $5 AND source = $6
        RETURNING id::text`,
        [row.id, sourceId, row.row_num, row.source_markdown_slug, row.fact, row.source],
      );
      if (changed.length !== 1) throw new Error(`fact ${id} changed after recovery classification`);
    }
    return plan;
  });
}

interface CliArgs {
  repo: string;
  commit: string;
  source: string;
  mode: 'dry-run' | 'write-db' | 'write-files';
}

function parseCliArgs(argv: string[]): CliArgs {
  const read = (name: string): string => {
    const index = argv.indexOf(name);
    const value = index === -1 ? undefined : argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing required ${name}`);
    return value;
  };
  const writeDb = argv.includes('--write-db');
  const writeFiles = argv.includes('--write-files');
  if (writeDb && writeFiles) throw new Error('choose only one of --write-db or --write-files');
  if (argv.includes('--write')) throw new Error('--write was removed; use --write-db, verify, then --write-files');
  return {
    repo: read('--repo'),
    commit: read('--commit'),
    source: read('--source'),
    mode: writeDb ? 'write-db' : writeFiles ? 'write-files' : 'dry-run',
  };
}

function assertRecoveryPathsClean(repo: string, manifest: RecoveryManifest): void {
  const paths = [...manifest.addedPages, ...manifest.modifiedPages];
  if (paths.length === 0) return;
  const status = git(repo, ['status', '--porcelain=v1', '--', ...paths]);
  if (status.trim()) throw new Error('recovery target paths have uncommitted changes');
}

function assertFileRecoveryReady(manifest: RecoveryManifest, rows: RecoveryDbRow[]): void {
  const addedSlugs = new Set(manifest.addedPages.map(path => path.slice(0, -'.md'.length)));
  const stranded = rows.filter(row =>
    row.row_num !== null && row.source_markdown_slug !== null && addedSlugs.has(row.source_markdown_slug),
  );
  if (stranded.length > 0) {
    throw new Error(`database recovery is incomplete: ${stranded.length} fenced rows remain on added pages`);
  }
  const modifiedSlugs = new Set(manifest.modifiedPages.map(path => path.slice(0, -'.md'.length)));
  const targets = new Set(manifest.facts
    .filter(fact => modifiedSlugs.has(fact.pageSlug))
    .map(fact => `${fact.pageSlug}\0${factContentKey(fact)}`));
  const matching = rows.filter(row => row.row_num !== null && row.source_markdown_slug !== null &&
    targets.has(`${row.source_markdown_slug}\0${factContentKey(dbFact(row))}`));
  if (matching.length > 0) {
    throw new Error(`database recovery is incomplete: ${matching.length} target rows remain fenced on modified pages`);
  }
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

    assertRecoveryPathsClean(repo, manifest);
    const currentRows = await loadRecoveryRows(engine, args.source, manifest);
    let plan: RecoveryPlan;
    let files: FileRecovery;
    if (args.mode === 'write-db') {
      files = buildFileRecovery(repo, manifest);
      plan = await recoverDatabase(engine, args.source, manifest, true);
    } else if (args.mode === 'write-files') {
      assertFileRecoveryReady(manifest, currentRows);
      files = buildFileRecovery(repo, manifest);
      plan = classifyRecoveryRows(manifest, currentRows);
      applyFileRecovery(repo, files);
    } else {
      files = buildFileRecovery(repo, manifest);
      plan = classifyRecoveryRows(manifest, currentRows);
    }
    console.log(JSON.stringify({
      mode: args.mode,
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
