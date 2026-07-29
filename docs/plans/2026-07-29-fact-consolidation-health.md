# Fact Consolidation Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fact health and pending metrics truthful and let consolidation repair conservatively resolvable legacy entity buckets.

**Architecture:** Keep the engine's health API source-scoped, aggregate source snapshots in a doctor helper, align pending SQL with the consolidator's entity gate, and reuse entity resolution from the consolidation phase. Add a conservative structured-path resolver for canonical repo/project pages without creating new pages.

**Tech Stack:** TypeScript, Bun test runner, Postgres/PGLite engine implementations.

---

### Task 1: Report facts health across active sources

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `test/facts-health-doctor.test.ts`

- [ ] **Step 1: Write the failing test**

Create a PGLite-backed test that inserts recent facts only under `mind-agent-brain`, calls an exported `checkFactsHealth`, and asserts that the message reports the non-default source, its recent count, and no misleading `facts_health(default)` label.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/facts-health-doctor.test.ts`

Expected: FAIL because `checkFactsHealth` is not exported.

- [ ] **Step 3: Write minimal implementation**

Export `checkFactsHealth(engine)`. Query distinct `source_id` values from `facts`, call `getFactsHealth` for each source, sum all counters, and include the top three sources by active fact count in the message. Replace the hardcoded `getFactsHealth('default')` block with this helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/facts-health-doctor.test.ts`

Expected: PASS.

### Task 2: Exclude structurally ineligible rows from pending

**Files:**
- Modify: `src/core/engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Test: `test/recall-extensions.test.ts`

- [ ] **Step 1: Write the failing test**

Insert an active terminal-style fact with `entity_slug: null` and an active semantic fact with an entity. Assert `countUnconsolidatedFacts` returns one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/recall-extensions.test.ts`

Expected: FAIL with actual count two.

- [ ] **Step 3: Write minimal implementation**

Add `AND entity_slug IS NOT NULL` to both engine SQL implementations and update the interface documentation to define the count as consolidation-eligible active facts.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/recall-extensions.test.ts`

Expected: PASS.

### Task 3: Resolve structured canonical pages and repair legacy buckets

**Files:**
- Modify: `src/core/entities/resolve.ts`
- Modify: `src/core/cycle/phases/consolidate.ts`
- Test: `test/entity-resolve.test.ts`
- Test: `test/cycle-consolidate.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Seed canonical pages at `default/sources/github/repo-brain/example/fw-ble-detector/readme` and `default/sources/github/repo-brain/example/ms-maestro-scheduler/readme`. Assert `fw-ble-detector` and `ms-ms-maestro-scheduler-prod` resolve to those pages with source `fuzzy_match`.

- [ ] **Step 2: Run resolver tests to verify they fail**

Run: `bun test test/entity-resolve.test.ts`

Expected: FAIL because both inputs currently return `fallback_slugify`.

- [ ] **Step 3: Implement conservative structured-path resolution**

Generate deterministic token variants, query candidate paths, require complete path-segment matches, prefer unique `readme`/`index` or direct canonical leaves, and run this step before generic fuzzy matching.

- [ ] **Step 4: Run resolver tests to verify they pass**

Run: `bun test test/entity-resolve.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing consolidation migration test**

Insert a canonical repo readme page and three old same-vector facts under its bare legacy entity slug. Run consolidation and assert one take is attached to the canonical page and all contributing facts now carry the canonical slug.

- [ ] **Step 6: Run consolidation test to verify it fails**

Run: `bun test test/cycle-consolidate.test.ts`

Expected: FAIL because the phase skips the missing exact page bucket.

- [ ] **Step 7: Implement canonical bucket migration**

Resolve a missing bucket before loading its facts. For a non-fallback canonical result, update active unconsolidated rows from the legacy slug to the canonical slug unless `dryRun`, then cluster against the canonical bucket and use the canonical page.

- [ ] **Step 8: Run consolidation test to verify it passes**

Run: `bun test test/cycle-consolidate.test.ts`

Expected: PASS.

### Task 4: Verify the complete patch

**Files:**
- Review: all modified files

- [ ] **Step 1: Run targeted regression suite**

Run: `bun test test/facts-health-doctor.test.ts test/facts-doctor-shape.test.ts test/recall-extensions.test.ts test/entity-resolve.test.ts test/cycle-consolidate.test.ts test/consolidate-valid-until.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Run static and repository verification**

Run: `bun run typecheck && bun run verify`

Expected: both commands exit zero.

- [ ] **Step 3: Run full unit suite**

Run: `bun test`

Expected: zero failures.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only scoped files changed.
