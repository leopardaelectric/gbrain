# Facts Fence Migration Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent invalid facts-fence pages, make partial retries collision-safe, and recover only the Vammo partial migration state.

**Architecture:** The migration filters unsafe targets before filesystem work and stamps each page in one database transaction. A dry-run-first recovery helper derives scope from the known git commit, applies it by content to the current tree, preserves later facts, and refuses ambiguous fact matches.

**Tech Stack:** TypeScript, Bun test, BrainEngine transactions, git diff plumbing, PostgreSQL/PGLite.

---

### Task 1: Add migration regression tests

**Files:**
- Modify: `test/migrations-v0_32_2.test.ts`

- [ ] Add a test that seeds a bare slug, runs phase B, and expects no root file, a null `row_num`, and `skipped_unprefixed=1`.
- [ ] Add a test that simulates file-written/database-unstamped state, inserts the exact derived fence occupant, reruns phase B, and expects the original legacy row to own the slot with no duplicate.
- [ ] Add a test that puts a different fact in the target slot and expects a failed page with no partial database stamping.
- [ ] Run `bun test test/migrations-v0_32_2.test.ts` and confirm the new tests fail for the expected missing behavior.

### Task 2: Implement safe and resumable phase B

**Files:**
- Modify: `src/commands/migrations/v0_32_2.ts`

- [ ] Count and skip directory-less slugs during dry-run and write runs.
- [ ] Replace per-row updates with one `engine.transaction()` per page.
- [ ] Before each stamp, query the target fence coordinate. Delete only an exact full-metadata duplicate; throw on a non-matching occupant.
- [ ] Restore the original page when its database transaction fails.
- [ ] Stamp the original legacy row after the target slot is clear.
- [ ] Run `bun test test/migrations-v0_32_2.test.ts` and confirm all tests pass.

### Task 3: Add commit-scoped recovery analysis

**Files:**
- Create: `scripts/recover-v0322-partial-migration.ts`
- Create: `test/recover-v0322-partial-migration.test.ts`

- [ ] Add pure helpers that read added/modified markdown blobs for one commit and derive added facts fence rows.
- [ ] Add tests for added pages, modified pages, unchanged fence rows, and ambiguous row matches.
- [ ] Run `bun test test/recover-v0322-partial-migration.test.ts` and confirm the tests fail before the helper exists.
- [ ] Implement dry-run output with exact page, fence-row, reset, and duplicate-delete counts.
- [ ] Implement `--write-db` in one locked database transaction, scoped to one source and content derived from the target commit.
- [ ] Implement a separate `--write-files` phase that requires the database postcondition. Preserve all later facts attached to pages created by the bad migration.
- [ ] Run the focused recovery tests and confirm they pass.

### Task 4: Verify and commit source changes

**Files:**
- Modify: all files above

- [ ] Run `bun test test/migrations-v0_32_2.test.ts test/recover-v0322-partial-migration.test.ts`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run verify`.
- [ ] Review `git diff --check` and the scoped source diff.
- [ ] Commit and push the active Vammo fork branch.

### Task 5: Recover the Vammo brain

**Files:**
- Modify/delete only paths introduced or changed by brain commit `ceb49d1bc`.

- [ ] Run the recovery helper without a write flag for source `mind-agent-brain` and commit `ceb49d1bc`; inspect all counts.
- [ ] Run the helper with `--write-db`; verify the database transaction completed.
- [ ] Run the helper with `--write-files`; remove the 462 pages created by commit `ceb49d1bc` and rewrite only the target facts on its 17 modified pages, without touching current unrelated worktree changes.
- [ ] Commit and push the scoped brain recovery.
- [ ] Run a source-scoped sync and verify deleted ghost pages disappear from the database.

### Task 6: Rerun and verify migration

**Files:**
- Modify: legitimate entity pages only, as produced by the corrected migration.

- [ ] Run the migration dry-run and confirm bare slugs are reported as skipped.
- [ ] Run the migration write mode.
- [ ] Confirm no root-level pages were created, no unique-index collision occurred, and no non-null fenceable legacy rows remain.
- [ ] Run `gbrain doctor --fast --json` and the relevant smoke checks.
- [ ] Commit and push legitimate brain page changes.
