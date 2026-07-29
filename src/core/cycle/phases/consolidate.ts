/**
 * v0.31 — Dream-cycle `consolidate` phase: facts → takes promotion.
 *
 * Per /plan-eng-review Phase 5:
 *
 *   For each (source_id, entity_slug) bucket of unconsolidated active facts:
 *     1. Skip if count < 3 OR oldest fact age < 24h.
 *     2. Cluster by embedding cosine — greedy threshold 0.85.
 *     3. For each cluster ≥ 2: pick the highest-confidence fact's text as
 *        the take claim (v0.31 ships without LLM synthesis to keep the
 *        cycle deterministic; see TODO at the bottom for the v0.32 Sonnet
 *        rewrite).
 *     4. Resolve entity_slug → pages.slug. If the page is missing, skip
 *        this cluster (no auto-page-creation in v0.31; the take needs a
 *        home).
 *     5. INSERT into takes(kind='fact', holder='self', source=concatenated
 *        source_sessions). row_num = MAX existing for the page + 1.
 *     6. UPDATE contributing facts: consolidated_at = now() +
 *        consolidated_into = takes.id. NEVER DELETE.
 *
 * The phase's totals contribute to the runCycle CycleReport via
 * extractTotals (cycle.ts) — facts_consolidated + takes_written.
 */

import type { BrainEngine, FactRow } from '../../engine.ts';
import type { PhaseResult } from '../../cycle.ts';
import { cosineSimilarity } from '../../facts/classify.ts';
import { resolveEntitySlugWithSource } from '../../entities/resolve.ts';
import { materializeConsolidatedTake } from '../consolidate-takes-fs.ts';

export interface ConsolidatePhaseOpts {
  dryRun?: boolean;
  /** Canonical source checkout. Null/undefined means DB-only promotion is forbidden. */
  brainDir?: string | null;
  /** Restrict consolidation to the cycle's resolved source. */
  sourceId?: string;
  /** In-phase keepalive callback. Awaited between buckets. */
  yieldDuringPhase?: () => Promise<void>;
  /** Cosine cluster threshold. Default 0.85. */
  clusterThreshold?: number;
  /** Minimum facts per (source, entity) bucket before consolidation. Default 3. */
  minFactsPerBucket?: number;
  /** Minimum age (ms) of the OLDEST fact in a bucket before consolidation. Default 24h. */
  minOldestAgeMs?: number;
}

export async function runPhaseConsolidate(
  engine: BrainEngine,
  opts: ConsolidatePhaseOpts = {},
): Promise<PhaseResult> {
  const dryRun = opts.dryRun === true;
  const threshold = opts.clusterThreshold ?? 0.85;
  const minPerBucket = opts.minFactsPerBucket ?? 3;
  const minOldestAgeMs = opts.minOldestAgeMs ?? 24 * 60 * 60 * 1000;

  let factsConsolidated = 0;
  let takesWritten = 0;
  let bucketsProcessed = 0;
  let bucketsSkipped = 0;
  let bucketsCanonicalized = 0;
  let takesSkippedNoMarkdown = 0;
  const materializationErrors: string[] = [];

  // Pull every (source_id, entity_slug) bucket of unconsolidated facts.
  // Uses the partial idx_facts_unconsolidated index.
  let buckets: Array<{ source_id: string; entity_slug: string; count: number }>;
  try {
    const sourceFilter = opts.sourceId ? 'AND source_id = $1' : '';
    const sourceParams = opts.sourceId ? [opts.sourceId] : [];
    buckets = await engine.executeRaw<{
      source_id: string; entity_slug: string; count: number;
    }>(`
      SELECT source_id, entity_slug, COUNT(*)::int AS count
      FROM facts
      WHERE consolidated_at IS NULL
        AND expired_at IS NULL
        AND entity_slug IS NOT NULL
        ${sourceFilter}
      GROUP BY source_id, entity_slug
      HAVING COUNT(*) >= ${minPerBucket}
    `, sourceParams);
  } catch (err) {
    return {
      phase: 'consolidate',
      status: 'fail',
      duration_ms: 0,
      summary: 'failed to scan unconsolidated facts',
      details: { error: err instanceof Error ? err.message : String(err) },
      error: {
        class: 'ConsolidateScanFailed',
        code: 'consolidate_scan_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  for (const b of buckets) {
    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* keepalive errors non-fatal */ }
    }

    const facts = await engine.listFactsByEntity(b.source_id, b.entity_slug, {
      activeOnly: true,
      limit: 100,
    });
    // Re-filter to unconsolidated since listFactsByEntity returns all active.
    const unconsolidated = facts.filter(f => f.consolidated_at == null);
    if (unconsolidated.length < minPerBucket) {
      bucketsSkipped += 1;
      continue;
    }

    // Age gate: oldest must be at least minOldestAgeMs old.
    const oldest = unconsolidated.reduce((min, f) =>
      f.valid_from.getTime() < min.valid_from.getTime() ? f : min,
    );
    if (Date.now() - oldest.valid_from.getTime() < minOldestAgeMs) {
      bucketsSkipped += 1;
      continue;
    }

    bucketsProcessed += 1;
    const clusters = clusterFacts(unconsolidated, threshold);

    // Resolve entity_slug → page_id. Legacy fallback slugs may predate a
    // canonical project/repository page or the structured-path resolver.
    // Re-resolve those buckets conservatively before giving up.
    let canonicalSlug = b.entity_slug;
    let pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
      [b.source_id, canonicalSlug],
    );
    if (pageRows.length === 0) {
      const resolved = await resolveEntitySlugWithSource(
        engine,
        b.source_id,
        b.entity_slug,
      );
      if (!resolved || resolved.source === 'fallback_slugify') continue;

      canonicalSlug = resolved.slug;
      pageRows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
        [b.source_id, canonicalSlug],
      );
      if (pageRows.length === 0) continue;

      bucketsCanonicalized += 1;
      if (!dryRun && canonicalSlug !== b.entity_slug) {
        await engine.executeRaw(
          `UPDATE facts
             SET entity_slug = $1
           WHERE source_id = $2
             AND entity_slug = $3
             AND consolidated_at IS NULL
             AND expired_at IS NULL`,
          [canonicalSlug, b.source_id, b.entity_slug],
        );
      }
    }
    const pageId = pageRows[0].id;

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      // Take selection: pick the highest-confidence fact's text as the
      // take claim (v0.31 deterministic). v0.32 will swap to a Sonnet
      // synthesis pass.
      const best = cluster.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      const avgWeight = cluster.reduce((s, f) => s + f.confidence, 0) / cluster.length;
      const sources = Array.from(new Set(cluster.map(c => c.source_session ?? c.source).filter(Boolean))).join(',');
      const sinceISO = cluster
        .map(c => c.valid_from)
        .reduce((min, d) => (d < min ? d : min))
        .toISOString()
        .slice(0, 10);

      if (dryRun) {
        // Pretend we did it.
        takesWritten += 1;
        factsConsolidated += cluster.length;
        continue;
      }

      // Markdown is canonical. Materialize the promoted take in the fenced
      // page first, atomically, then mirror that exact row into the DB.
      // Facts are not marked consolidated unless both steps succeed.
      let materialized;
      try {
        materialized = await materializeConsolidatedTake(
          engine,
          {
            sourceId: b.source_id,
            localPath: opts.brainDir ?? null,
            slug: canonicalSlug,
            pageId,
          },
          {
            claim: best.fact,
            weight: clamp01(avgWeight),
            sinceDate: sinceISO,
            source: sources.slice(0, 200),
          },
        );
      } catch (error) {
        takesSkippedNoMarkdown += 1;
        materializationErrors.push(
          `${b.source_id}:${canonicalSlug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (materialized.status === 'skipped') {
        takesSkippedNoMarkdown += 1;
        materializationErrors.push(
          `${b.source_id}:${canonicalSlug}: ${materialized.reason}`,
        );
        continue;
      }
      const takeId = materialized.takeId;
      if (materialized.created) takesWritten += 1;

      // Mark all contributing facts consolidated.
      for (const f of cluster) {
        await engine.consolidateFact(f.id, takeId);
        factsConsolidated += 1;
      }

      // v0.35.4 (D-CDX-4 part 2) — chronological valid_until writeback.
      // Sort the cluster by (valid_from ASC, id ASC); walk consecutive
      // pairs; stamp the older fact's valid_until = next_newer.valid_from.
      // The newest fact keeps valid_until = NULL. This makes the facts
      // table a proper bitemporal record without the contradiction probe
      // having to mutate it (preserves auto-supersession.ts:4 invariant —
      // see also R8 test guard).
      //
      // Idempotent: re-running on the same cluster produces the same
      // chronological order and the same valid_until values. No-op if
      // valid_until is already correct.
      const chronological = [...cluster].sort((a, b) => {
        const t = a.valid_from.getTime() - b.valid_from.getTime();
        if (t !== 0) return t;
        return a.id - b.id;
      });
      for (let i = 0; i < chronological.length - 1; i++) {
        const older = chronological[i];
        const newer = chronological[i + 1];
        await engine.executeRaw(
          // Only UPDATE when the new value would actually change. Avoids
          // touching updated_at on no-op rewrites and keeps idempotency
          // observable in the DB (zero affected rows on stable re-run).
          `UPDATE facts
             SET valid_until = $1
           WHERE id = $2
             AND (valid_until IS DISTINCT FROM $1)`,
          [newer.valid_from, older.id],
        );
      }
    }
  }

  return {
    phase: 'consolidate',
    status: factsConsolidated > 0 ? 'ok' : 'ok',
    duration_ms: 0,
    summary: dryRun
      ? `(dry-run) would promote ${factsConsolidated} facts into ${takesWritten} takes across ${bucketsProcessed} buckets`
      : `promoted ${factsConsolidated} facts into ${takesWritten} takes across ${bucketsProcessed} buckets`,
    details: {
      dryRun,
      facts_consolidated: factsConsolidated,
      takes_written: takesWritten,
      buckets_processed: bucketsProcessed,
      buckets_skipped: bucketsSkipped,
      buckets_canonicalized: bucketsCanonicalized,
      takes_skipped_no_markdown: takesSkippedNoMarkdown,
      materialization_errors: materializationErrors.slice(0, 20),
    },
  };
}

/**
 * Greedy cosine clustering. Iterate facts sorted by valid_from DESC; each
 * fact joins the first cluster whose centroid (the first member, for
 * simplicity) is within `threshold` cosine. Otherwise starts a new cluster.
 *
 * Facts with no embedding cluster on their own (single-element cluster);
 * the consolidate phase only writes takes from clusters of size ≥ 2, so
 * no-embedding singletons sit out the cycle. v0.32+ fact-extraction
 * pipeline ensures embeddings are computed at insertFact time.
 */
function clusterFacts(facts: FactRow[], threshold: number): FactRow[][] {
  const sorted = [...facts].sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime());
  const clusters: FactRow[][] = [];
  for (const f of sorted) {
    if (!f.embedding) {
      clusters.push([f]);
      continue;
    }
    let placed = false;
    for (const c of clusters) {
      const head = c[0];
      if (!head.embedding) continue;
      if (cosineSimilarity(f.embedding, head.embedding) >= threshold) {
        c.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([f]);
  }
  return clusters;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
