# Verified Typed Link Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deterministic `typed_ner` relations available to relational retrieval while plain body-mention links remain excluded.

**Architecture:** Keep extraction provenance unchanged: deterministic verb-pattern edges remain `link_source='mentions'` with `link_kind='typed_ner'`. Change only the relational fan-out eligibility predicate in both engines so verified typed NER edges participate by default, while `includeMentions` still controls whether plain mention edges participate. Pin the behavior with PGLite, Postgres parity, and end-to-end retrieval A/B tests.

**Tech Stack:** TypeScript, Bun test, PGLite, Postgres/pgvector.

---

### Task 1: Pin typed-NER graph eligibility

**Files:**
- Modify: `test/relational-fanout.test.ts`
- Modify: `test/e2e/engine-parity.test.ts`

- [ ] **Step 1: Write the failing PGLite test**

Add a synthetic person page and this typed-NER edge in the relational fixture:

```ts
await eng.addLinksBatch([{
  from_slug: 'people/typed-ner-worker',
  to_slug: 'companies/widget-co',
  link_type: 'works_at',
  link_source: 'mentions',
  link_kind: 'typed_ner',
  context: 'works at Widget Co',
  from_source_id: 'default',
  to_source_id: 'default',
}]);
```

Update the mention-filter test to assert that the default walk includes `people/typed-ner-worker`, excludes `people/mentioner`, and that `includeMentions: true` includes both.

- [ ] **Step 2: Run the PGLite test and verify RED**

Run: `bun test test/relational-fanout.test.ts`

Expected: FAIL because `people/typed-ner-worker` is absent from the default walk.

- [ ] **Step 3: Add the same fixture and assertions to engine parity**

Seed `people/ep-typed-ner` through `addLinksBatch` with `link_kind='typed_ner'`. Assert both engines include it by default and exclude the plain mention row.

### Task 2: Admit verified typed-NER edges in both engines

**Files:**
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/engine.ts`

- [ ] **Step 1: Change the PGLite predicate**

Replace the default mention filter with:

```ts
const mentionsFilter = opts?.includeMentions
  ? ''
  : `AND (l.link_source IS DISTINCT FROM 'mentions' OR l.link_kind = 'typed_ner')`;
```

- [ ] **Step 2: Change the Postgres predicate in lockstep**

Use the equivalent postgres.js fragment:

```ts
const mentionsFilter = opts?.includeMentions
  ? sql``
  : sql`AND (l.link_source IS DISTINCT FROM 'mentions' OR l.link_kind = 'typed_ner')`;
```

- [ ] **Step 3: Update the engine contract**

State that plain `mentions` edges are excluded by default, but deterministic `link_kind='typed_ner'` relations are included.

- [ ] **Step 4: Run the focused graph tests and verify GREEN**

Run: `bun test test/relational-fanout.test.ts test/relational-recall.test.ts`

Expected: all tests pass.

### Task 3: Prove retrieval lift and document the boundary

**Files:**
- Modify: `test/relational-ab.test.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/architecture/RETRIEVAL.md`

- [ ] **Step 1: Write an end-to-end typed-NER A/B test**

Seed a lexically unrelated person page connected to `companies/widget-co` by a `works_at` / `mentions` / `typed_ner` row. Query `who works at widget-co` with relational retrieval off and on. Assert the person is absent with the arm off and present with it on.

- [ ] **Step 2: Run the A/B test**

Run: `bun test test/relational-ab.test.ts`

Expected: all tests pass after Task 2 and the new typed-NER A/B assertion proves the lift.

- [ ] **Step 3: Update current-state documentation**

Replace broad “mentions-excluded” statements with the exact rule: plain auto-mentions are excluded; deterministic typed-NER relations are included.

- [ ] **Step 4: Run focused and structural verification**

Run:

```bash
bun test test/relational-fanout.test.ts test/relational-recall.test.ts test/relational-ab.test.ts test/by-mention.test.ts test/extract-ner-target-type.test.ts
bun run typecheck
bun run build:llms
bun run ci:local:diff
```

Expected: zero failures. If Docker or Postgres is unavailable, report the unavailable parity lane explicitly and keep the unit/typecheck evidence separate.

- [ ] **Step 5: Run the live mutation gate**

Run a read-only typed-NER extraction dry run on the configured brain. Compare candidate counts and retrieval behavior before any graph write. Only apply candidates if the dry-run evidence is bounded and the retrieval A/B is positive.

### Task 4: Keep inferred relationship ownership semantically valid

**Files:**
- Modify: `src/core/extract-ner.ts`
- Modify: `test/extract-ner-target-type.test.ts`

- [ ] **Step 1: Write the failing source-type test**

Assert that `person`, `company`, `organization`, and `entity` pages may own an inferred relation, while `conversation`, `slack`, `report`, `note`, and `project` pages may not.

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test test/extract-ner-target-type.test.ts`

Expected: FAIL because `isEligibleNerSourceType` does not exist.

- [ ] **Step 3: Add the source-owner gate**

Export `isEligibleNerSourceType(type)` from `extract-ner.ts` and skip every non-entity source page before relation inference. This prevents a sentence inside a Slack thread from incorrectly asserting that the thread itself `works_at` a company.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test test/extract-ner-target-type.test.ts test/relational-ab.test.ts`

Expected: all tests pass.
