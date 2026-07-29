/**
 * Markdown-first writer for Dream's fact-cluster → take promotion.
 *
 * Takes are filesystem-canonical. This module owns the only legal ordering
 * for consolidation writes:
 *
 *   page lock → fenced Markdown atomic rename → derived DB mirror
 *
 * If the DB mirror fails, Markdown remains recoverable by `extract takes`.
 * Facts are marked consolidated by the caller only after this function
 * returns a take id.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import {
  parseTakesFence,
  renderTakesFence,
  type ParsedTake,
} from '../takes-fence.ts';

export interface ConsolidatedTakeInput {
  claim: string;
  weight: number;
  sinceDate: string;
  source: string;
}

export interface ConsolidatedTakeBodyOpts {
  preferredRowNum: number;
  /** Row numbers occupied by a different DB take. */
  occupiedRowNums?: ReadonlySet<number>;
  /** Highest row number known across the Markdown fence and DB mirror. */
  maxKnownRowNum?: number;
}

export interface ConsolidatedTakeBodyResult {
  body: string;
  rowNum: number;
  created: boolean;
  changed: boolean;
}

export interface ConsolidatedTakeTarget {
  sourceId: string;
  localPath: string | null;
  slug: string;
  pageId: number;
}

export type MaterializeConsolidatedTakeResult =
  | {
      status: 'written';
      rowNum: number;
      takeId: number;
      created: boolean;
      markdownChanged: boolean;
    }
  | {
      status: 'skipped';
      reason: 'no_local_checkout' | 'page_file_missing';
    };

interface DbTakeIdentityRow {
  id: number;
  row_num: number;
  claim: string;
  since_date: string | null;
  weight: number;
}

const FENCE_RE =
  /<!---?\s*gbrain:takes:begin\s*-->[\s\S]*?<!---?\s*gbrain:takes:end\s*-->/;

function sameTakeIdentity(
  take: Pick<ParsedTake, 'claim' | 'sinceDate'>,
  input: ConsolidatedTakeInput,
): boolean {
  return take.claim === input.claim
    && (take.sinceDate ?? null) === input.sinceDate;
}

function replaceOrAppendFence(body: string, takes: ParsedTake[]): string {
  const fence = renderTakesFence(takes);
  if (FENCE_RE.test(body)) {
    return body.replace(FENCE_RE, fence);
  }
  const separator = body.endsWith('\n') ? '\n' : '\n\n';
  return `${body}${separator}## Takes\n\n${fence}\n`;
}

/**
 * Pure semantic upsert used by the locked filesystem writer and unit tests.
 *
 * Identity is `(claim, sinceDate)`. A rerun refreshes source provenance but
 * preserves the original weight and row number unless that row number is
 * occupied by a different DB take, in which case the canonical row moves to
 * the first free number after every known row.
 */
export function upsertConsolidatedTakeBody(
  body: string,
  input: ConsolidatedTakeInput,
  opts: ConsolidatedTakeBodyOpts,
): ConsolidatedTakeBodyResult {
  const parsed = parseTakesFence(body);
  if (parsed.warnings.length > 0) {
    throw new Error(`takes fence invalid: ${parsed.warnings.join('; ')}`);
  }

  const semanticIndex = parsed.takes.findIndex(t => sameTakeIdentity(t, input));
  const semantic = semanticIndex >= 0 ? parsed.takes[semanticIndex] : undefined;
  const occupiedByFence = new Set(
    parsed.takes
      .filter((_, index) => index !== semanticIndex)
      .map(t => t.rowNum),
  );
  const occupiedByDb = opts.occupiedRowNums ?? new Set<number>();
  const maxFenceRow = parsed.takes.reduce((max, take) => Math.max(max, take.rowNum), 0);
  const maxKnownRow = Math.max(
    maxFenceRow,
    opts.maxKnownRowNum ?? 0,
    opts.preferredRowNum - 1,
  );

  let rowNum = semantic?.rowNum ?? opts.preferredRowNum;
  if (occupiedByFence.has(rowNum) || occupiedByDb.has(rowNum)) {
    rowNum = maxKnownRow + 1;
    while (occupiedByFence.has(rowNum) || occupiedByDb.has(rowNum)) rowNum += 1;
  }

  const next: ParsedTake = semantic
    ? {
        ...semantic,
        rowNum,
        source: input.source || semantic.source,
      }
    : {
        rowNum,
        claim: input.claim,
        kind: 'fact',
        holder: 'self',
        weight: input.weight,
        sinceDate: input.sinceDate,
        source: input.source || undefined,
        active: true,
      };

  const takes = semantic
    ? parsed.takes.map((take, index) => index === semanticIndex ? next : take)
    : [...parsed.takes, next];
  const nextBody = replaceOrAppendFence(body, takes);
  const reparsed = parseTakesFence(nextBody);
  if (reparsed.warnings.length > 0) {
    throw new Error(`rendered takes fence invalid: ${reparsed.warnings.join('; ')}`);
  }

  return {
    body: nextBody,
    rowNum,
    created: semantic === undefined,
    changed: nextBody !== body,
  };
}

/**
 * Materialize one promoted take into Markdown, then mirror the exact row into
 * the DB. Never creates a page: consolidation already resolved an imported
 * canonical page, so a missing file signals source/check-out drift.
 */
export async function materializeConsolidatedTake(
  engine: BrainEngine,
  target: ConsolidatedTakeTarget,
  input: ConsolidatedTakeInput,
): Promise<MaterializeConsolidatedTakeResult> {
  if (target.localPath === null) {
    return { status: 'skipped', reason: 'no_local_checkout' };
  }

  const filePath = join(target.localPath, `${target.slug}.md`);
  if (!existsSync(filePath)) {
    return { status: 'skipped', reason: 'page_file_missing' };
  }

  return withPageLock(
    target.slug,
    async () => {
      const body = readFileSync(filePath, 'utf8');
      const dbRows = await engine.executeRaw<DbTakeIdentityRow>(
        `SELECT id, row_num, claim, since_date, weight
           FROM takes
          WHERE page_id = $1
          ORDER BY row_num`,
        [target.pageId],
      );
      const dbSemantic = dbRows.find(row =>
        row.claim === input.claim && row.since_date === input.sinceDate,
      );
      const occupied = new Set(
        dbRows
          .filter(row => row.id !== dbSemantic?.id)
          .map(row => row.row_num),
      );
      const maxDbRow = dbRows.reduce((max, row) => Math.max(max, row.row_num), 0);
      const preferredRowNum = dbSemantic?.row_num ?? maxDbRow + 1;

      const materialized = upsertConsolidatedTakeBody(body, input, {
        preferredRowNum,
        occupiedRowNums: occupied,
        maxKnownRowNum: maxDbRow,
      });

      if (materialized.changed) {
        const tmpPath =
          `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          writeFileSync(tmpPath, materialized.body, 'utf8');
          const parsedTmp = parseTakesFence(readFileSync(tmpPath, 'utf8'));
          if (parsedTmp.warnings.length > 0) {
            throw new Error(
              `rendered takes fence invalid: ${parsedTmp.warnings.join('; ')}`,
            );
          }
          renameSync(tmpPath, filePath);
        } catch (error) {
          try {
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
          } catch {
            // Best-effort cleanup; preserve the original write error.
          }
          throw error;
        }
      }

      if (dbSemantic && dbSemantic.row_num !== materialized.rowNum) {
        await engine.executeRaw(
          `UPDATE takes
              SET row_num = $1,
                  claim = $2,
                  kind = 'fact',
                  holder = 'self',
                  source = $3,
                  since_date = $4,
                  active = true,
                  updated_at = now()
            WHERE id = $5`,
          [
            materialized.rowNum,
            input.claim,
            input.source,
            input.sinceDate,
            dbSemantic.id,
          ],
        );
      } else {
        await engine.addTakesBatch([{ // gbrain-allow-direct-insert: Markdown-first Dream take materializer mirrors only after the atomic fence write
          page_id: target.pageId,
          row_num: materialized.rowNum,
          claim: input.claim,
          kind: 'fact',
          holder: 'self',
          weight: dbSemantic?.weight ?? input.weight,
          since_date: input.sinceDate,
          source: input.source,
          active: true,
        }]);
      }

      const idRows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM takes WHERE page_id = $1 AND row_num = $2 LIMIT 1`,
        [target.pageId, materialized.rowNum],
      );
      if (!idRows[0]) {
        throw new Error(
          `take DB mirror missing after Markdown write: ${target.slug}#${materialized.rowNum}`,
        );
      }

      return {
        status: 'written',
        rowNum: materialized.rowNum,
        takeId: idRows[0].id,
        created: dbSemantic === undefined,
        markdownChanged: materialized.changed,
      };
    },
    { timeoutMs: 5_000 },
  );
}
