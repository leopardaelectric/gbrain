// src/core/extract-takes-from-pages.ts
// v0.41.18.0 (A12, A24, T9). Haiku classifier loop over allowlisted page
// types — concept, atom, lore, briefing, writing, originals — extracts
// gradeable claims and writes them to canonical takes fence rows before
// mirroring those rows into the DB.
//
// Two-gate consent per A12:
//   - takes.bootstrap_enabled (default false): must be true to run at all.
//     Even manual `gbrain takes extract --from-pages` refuses without it.
//   - takes.autopilot_allowed (default false): must be true for autopilot's
//     auto-apply tier to fire the takes-bootstrap remediation.
//
// A24 deliberately limits autopilot to manual_only until v0.42.1 lands a
// 100+-case eval suite. v0.42 ships the classifier + CLI; autopilot stays
// blocked until eval coverage catches up.

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { BrainEngine } from './engine.ts';
import type { TakeBatchInput, TakeKind } from './engine.ts';
import { chat, isAvailable } from './ai/gateway.ts';
import { withPageLock } from './page-lock.ts';
import { parseTakesFence, upsertTakeRow } from './takes-fence.ts';

export const ALLOWED_PAGE_TYPES = [
  'concept', 'atom', 'lore', 'briefing', 'writing', 'originals',
] as const;

const CLASSIFIER_SYSTEM = `You extract gradeable CLAIMS from longform writing.

Output strict JSON: an array of objects with shape:
  {"claim": "<short imperative or assertion, <= 200 chars>",
   "kind": "fact" | "take" | "bet" | "hunch",
   "weight": 0.0..1.0}

Kind taxonomy:
  - fact: verifiable as true/false (e.g. "X raised $5M in Mar 2024")
  - take: a stated opinion that could be wrong (e.g. "X is undervalued")
  - bet:  a forward-looking prediction (e.g. "X will IPO in 2026")
  - hunch: a low-confidence gut feeling (e.g. "Y feels overstretched")

Skip pure narrative, questions, definitions, or pure quotes from others.
Max 15 claims per page; output [] if no gradeable claims are present.`;

export interface ExtractTakesFromPagesOpts {
  /** Required: must be true for any work to happen (A12). */
  bootstrapEnabled: boolean;
  /** Dry-run: classify but don't write to takes table. */
  dryRun?: boolean;
  /** Scope to a single source. */
  sourceIdFilter?: string;
  /** Max pages to classify per run (caps cost). Default 50. */
  maxPages?: number;
  /** Owner identifier for the inserted takes. Default 'system'. */
  holder?: string;
  /** Model override; defaults to facts.extraction_model. */
  model?: string;
  /** Progress hook called per page. */
  onProgress?: (done: number, total: number, claims: number) => void;
}

export interface ExtractTakesFromPagesResult {
  pages_scanned: number;
  claims_extracted: number;
  /** True if the run was a no-op because bootstrapEnabled is false. */
  consent_gate_blocked: boolean;
  /** True if chat gateway is unavailable (no LLM call possible). */
  llm_unavailable: boolean;
}

interface PageRow {
  id: number;
  slug: string;
  source_id: string;
  type: string;
  compiled_truth: string;
  updated_at: string | Date;
}

export interface ExtractedTakeClaim {
  claim: string;
  kind: TakeKind;
  weight: number;
}

export interface ExtractedTakesPageTarget {
  localPath: string | null;
  pageId: number;
  slug: string;
  holder: string;
}

/**
 * Pure helper: parse Haiku JSON output into typed claims. Returns []
 * on any parse failure (caller treats as "no claims extracted").
 */
export function parseClaimsJson(raw: string): ExtractedTakeClaim[] {
  try {
    // Strip code fences if model wrapped output in ```json.
    let text = raw.trim();
    const fenceMatch = text.match(/^```(?:json)?\n?([\s\S]*?)\n?```$/);
    if (fenceMatch) text = fenceMatch[1].trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const valid: ExtractedTakeClaim[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const claim = typeof item.claim === 'string' ? item.claim.trim().slice(0, 200) : '';
      const kind = typeof item.kind === 'string' ? item.kind : '';
      const weightRaw = typeof item.weight === 'number' ? item.weight : 0.5;
      const weight = Math.max(0, Math.min(1, weightRaw));
      if (!claim || !['fact', 'take', 'bet', 'hunch'].includes(kind)) continue;
      valid.push({ claim, kind, weight });
    }
    return valid;
  } catch {
    return [];
  }
}

/**
 * Persist classifier-generated takes through their canonical Markdown fence,
 * then mirror those exact rows to the DB. Existing semantic rows are included
 * in the DB mirror so a prior post-rename DB failure repairs on retry.
 *
 * Returns the number of new Markdown rows appended, not the number of DB
 * upserts, so idempotent reruns report zero new claims.
 */
export async function writeExtractedTakesToPage(
  engine: BrainEngine,
  target: ExtractedTakesPageTarget,
  claims: ExtractedTakeClaim[],
): Promise<number> {
  if (target.localPath === null || claims.length === 0) return 0;
  const filePath = join(target.localPath, `${target.slug}.md`);
  if (!existsSync(filePath)) return 0;

  return withPageLock(
    target.slug,
    async () => {
      let body = readFileSync(filePath, 'utf8');
      const initial = parseTakesFence(body);
      if (initial.warnings.length > 0) {
        throw new Error(`takes fence invalid: ${initial.warnings.join('; ')}`);
      }

      const rowByIdentity = new Map(
        initial.takes.map(take => [
          `${take.kind}\u0000${take.holder}\u0000${take.claim}`,
          take,
        ]),
      );
      const batch: TakeBatchInput[] = [];
      let appended = 0;

      for (const claim of claims) {
        const identity = `${claim.kind}\u0000${target.holder}\u0000${claim.claim}`;
        let take = rowByIdentity.get(identity);
        if (!take) {
          const written = upsertTakeRow(body, {
            claim: claim.claim,
            kind: claim.kind,
            holder: target.holder,
            weight: claim.weight,
            source: 'cli:takes-bootstrap-from-pages',
            active: true,
          });
          body = written.body;
          take = parseTakesFence(body).takes.find(t => t.rowNum === written.rowNum);
          if (!take) {
            throw new Error(
              `rendered take row missing: ${target.slug}#${written.rowNum}`,
            );
          }
          rowByIdentity.set(identity, take);
          appended += 1;
        }
        batch.push({
          page_id: target.pageId,
          row_num: take.rowNum,
          claim: take.claim,
          kind: take.kind,
          holder: take.holder,
          weight: take.weight,
          since_date: take.sinceDate,
          until_date: take.untilDate,
          source: take.source,
          active: take.active,
        });
      }

      if (appended > 0) {
        const tmpPath =
          `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          writeFileSync(tmpPath, body, 'utf8');
          const reparsed = parseTakesFence(readFileSync(tmpPath, 'utf8'));
          if (reparsed.warnings.length > 0) {
            throw new Error(
              `rendered takes fence invalid: ${reparsed.warnings.join('; ')}`,
            );
          }
          renameSync(tmpPath, filePath);
        } catch (error) {
          try {
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
          } catch {
            // Best-effort temp cleanup; preserve the original error.
          }
          throw error;
        }
      }

      await engine.addTakesBatch(batch); // gbrain-allow-direct-insert: classifier takes are mirrored only after their canonical Markdown rows exist
      return appended;
    },
    { timeoutMs: 5_000 },
  );
}

export async function extractTakesFromPages(
  engine: BrainEngine,
  opts: ExtractTakesFromPagesOpts,
): Promise<ExtractTakesFromPagesResult> {
  // A12 consent gate: refuse without bootstrap_enabled even on manual call.
  if (!opts.bootstrapEnabled) {
    return {
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: true,
      llm_unavailable: false,
    };
  }

  if (!isAvailable('chat')) {
    return {
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: false,
      llm_unavailable: true,
    };
  }

  const dryRun = opts.dryRun ?? false;
  const maxPages = opts.maxPages ?? 50;
  const holder = opts.holder ?? 'system';
  const sourceFilter = opts.sourceIdFilter ? `AND source_id = $1` : '';
  const params = opts.sourceIdFilter ? [opts.sourceIdFilter] : [];

  // Fetch eligible pages. Order by updated_at DESC so recently-edited
  // pages get bootstrapped first.
  const typesList = ALLOWED_PAGE_TYPES.map((t) => `'${t}'`).join(', ');
  const pages = await engine.executeRaw<PageRow>(
    `SELECT id, slug, source_id, type, compiled_truth, updated_at
       FROM pages
      WHERE type IN (${typesList})
        AND deleted_at IS NULL
        AND length(COALESCE(compiled_truth, '')) > 200
        ${sourceFilter}
      ORDER BY updated_at DESC
      LIMIT ${maxPages}`,
    params,
  );

  let pagesScanned = 0;
  let claimsExtracted = 0;
  const sourceRows = await engine.executeRaw<{
    id: string;
    local_path: string | null;
  }>(`SELECT id, local_path FROM sources`);
  const sourcePaths = new Map(
    sourceRows.map(row => [row.id, row.local_path] as const),
  );
  const legacyRepoPath = await engine.getConfig('sync.repo_path');

  for (const page of pages) {
    pagesScanned++;
    opts.onProgress?.(pagesScanned, pages.length, claimsExtracted);

    if (!page.compiled_truth || page.compiled_truth.length < 200) continue;

    // Truncate to keep per-page cost bounded (~20K chars → ~5K input tokens).
    const text = page.compiled_truth.slice(0, 20_000);

    let response: { text: string };
    try {
      response = await chat({
        model: opts.model ?? 'anthropic:claude-haiku-4-5',
        system: CLASSIFIER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `<page slug="${page.slug}" type="${page.type}">\n${text}\n</page>`,
          },
        ],
        maxTokens: 2000,
      });
    } catch {
      // Skip pages whose chat call fails (rate limit, content filter,
      // transient error). Per-page progress continues.
      continue;
    }

    const claims = parseClaimsJson(response.text);
    if (claims.length === 0) continue;

    if (dryRun) {
      claimsExtracted += claims.length;
      continue;
    }
    const localPath = sourcePaths.get(page.source_id)
      ?? (page.source_id === 'default' ? legacyRepoPath : null);
    try {
      claimsExtracted += await writeExtractedTakesToPage(
        engine,
        {
          localPath,
          pageId: page.id,
          slug: page.slug,
          holder,
        },
        claims,
      );
    } catch {
      // Per-page durability failure: leave DB untouched and continue.
    }
  }

  return {
    pages_scanned: pagesScanned,
    claims_extracted: claimsExtracted,
    consent_gate_blocked: false,
    llm_unavailable: false,
  };
}
