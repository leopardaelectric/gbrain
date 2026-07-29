# Dream takes: Markdown-first durability

## Problem

`runPhaseConsolidate` promotes fact clusters by writing directly to `takes`.
That violates `docs/architecture/system-of-record.md`: takes are
filesystem-canonical and must survive a database rebuild from Markdown.

## Design

Dream consolidation will use the same Markdown-first contract as
`gbrain takes add`:

1. Resolve the cycle's source checkout and canonical page slug.
2. Acquire the existing per-page lock.
3. Read the canonical page and materialize the promoted take in its fenced
   `## Takes` table.
4. Validate the rendered fence and atomically rename the new file into place.
5. Mirror the exact Markdown row into `takes`.
6. Only after both durable Markdown and the DB mirror exist, mark the
   contributing facts consolidated.

The Markdown row is deduplicated by the existing promoted-take identity
`(claim, since_date)`. Repeated cycles update its aggregated source rather
than append duplicates. Row numbers remain stable. If a legacy DB-only take
exists, the phase repairs it into the fence and aligns the DB row to the
Markdown row.

When the source has no local checkout, consolidation skips the promotion
instead of creating more DB-only user knowledge. Dry runs perform no file or
database writes.

## Failure behavior

- Missing page file, malformed fence, lock timeout, or atomic-write failure:
  do not write the take to the DB and do not mark facts consolidated.
- DB mirror failure after the atomic Markdown write: leave Markdown as the
  recoverable source of truth; the next extract/consolidate pass repairs DB.
- A phase result reports skipped/failed materializations so operators can see
  durability problems.

## Verification

- Unit tests cover append, semantic idempotency, legacy DB-only repair, source
  refresh, dry-run, and missing-checkout behavior.
- Cycle integration proves the take exists in both the fenced Markdown page
  and `takes`, and that a second run creates neither a duplicate row nor a
  duplicate fence entry.
- The system-of-record CI gate continues to reject direct take inserts outside
  the Markdown-first reconciler.
