# Dream Takes Markdown Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dream-promoted takes recoverable from canonical Markdown and therefore eligible for the brain repo's GitHub sync.

**Architecture:** Add a focused Markdown-first take materializer that owns locking, semantic deduplication, atomic fence validation, and DB mirroring. Thread the cycle's resolved checkout/source into consolidation and prohibit DB-only promotion when no checkout exists.

**Tech Stack:** TypeScript, Bun test, PGLite, fenced Markdown, filesystem locks.

---

### Task 1: Pin the Markdown-first contract

**Files:**
- Create: `test/consolidate-takes-fs.test.ts`
- Modify: `test/cycle-consolidate.test.ts`

- [ ] Write failing tests for new fence creation, semantic idempotency, source refresh, legacy DB-only repair, and no-checkout behavior.
- [ ] Run `bun test test/consolidate-takes-fs.test.ts test/cycle-consolidate.test.ts` and verify the new assertions fail because consolidation does not write Markdown.
- [ ] Commit the red tests.

### Task 2: Add the take materializer

**Files:**
- Create: `src/core/cycle/consolidate-takes-fs.ts`
- Test: `test/consolidate-takes-fs.test.ts`

- [ ] Implement a pure semantic upsert over `ParsedTake[]`, keyed by `(claim, sinceDate)`, preserving row identity and refreshing source provenance.
- [ ] Implement per-page locked read/modify/write using a unique sibling temp file, `parseTakesFence` validation, and atomic rename.
- [ ] Mirror the chosen Markdown row into the DB and repair a legacy semantic row when its DB row number differs.
- [ ] Run the focused test and verify it passes.
- [ ] Commit the materializer.

### Task 3: Route Dream consolidation through Markdown

**Files:**
- Modify: `src/core/cycle/phases/consolidate.ts`
- Modify: `src/core/cycle.ts`
- Modify: `test/cycle-consolidate.test.ts`
- Modify: `test/consolidate-valid-until.test.ts`

- [ ] Thread `brainDir` and `sourceId` from `runCycle` into `runPhaseConsolidate`.
- [ ] Scope candidate buckets to the resolved source when supplied.
- [ ] Replace direct `addTakesBatch`/source update writes with the Markdown-first materializer.
- [ ] Mark facts consolidated only after materialization and DB mirroring succeed.
- [ ] Run the consolidation tests and verify Markdown/DB idempotency.
- [ ] Commit the integration.

### Task 4: Reinforce the system-of-record gate

**Files:**
- Modify: `scripts/check-system-of-record.sh`
- Modify: `docs/architecture/system-of-record.md`

- [ ] Allow direct take mirroring only inside the new reconciler.
- [ ] Document Dream consolidation as a Markdown-first writer.
- [ ] Run `bash scripts/check-system-of-record.sh`.
- [ ] Commit the guard and documentation.

### Task 5: Verify the production path

**Files:**
- No new files.

- [ ] Run `bun test test/consolidate-takes-fs.test.ts test/cycle-consolidate.test.ts test/consolidate-valid-until.test.ts test/e2e/cycle-consolidate-postgres.test.ts`.
- [ ] Run `bash scripts/check-system-of-record.sh`.
- [ ] Run `git diff --check`.
- [ ] Run a real production dry-run and confirm it proposes takes without touching Markdown or DB.
- [ ] Restart the Dream daemon on the verified build and confirm the consolidate handler is registered.
