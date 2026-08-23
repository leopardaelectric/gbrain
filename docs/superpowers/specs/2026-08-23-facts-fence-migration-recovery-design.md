# Facts Fence Migration Recovery Design

## Problem

The v0.32.2 facts-fence migration writes every non-null `entity_slug` to a
markdown page. Unlike the current facts writer, it does not reject bare slugs.
On the Vammo brain this created 462 root-level pages and stamped 904 facts into
those fences. The periodic brain sync then committed those pages.

Five legitimate page groups also stopped after the file rename but before the
legacy database rows were stamped. A later sync indexed the new fence rows as
separate facts. A migration retry now attempts to assign the same fence slots
to the original legacy rows and hits `idx_facts_fence_key`.

## Selected Approach

Use the current writer's safety boundary in the migration: a new fence page
requires a directory-qualified slug. Bare slugs remain legacy database-only
facts and are reported as skipped.

Make page stamping resumable. For each assignment, inspect the target fence
slot inside one database transaction. If the slot is empty, stamp the legacy
row. If the slot contains an exact full-metadata duplicate created by a partial
run and sync, delete that derived duplicate and stamp the original legacy row.
If the occupant differs, fail the page and restore both the database and file
to their pre-page state.

Recover production using the exact auto-sync commit that captured the partial
migration as a scope manifest. Later syncs changed legitimate pages after that
commit, so a commit-level revert is unsafe. Reset all facts currently attached
to the 462 pages created by the bad migration, remove those pages, and preserve
later facts as legacy DB-only rows. On the 17 legitimate pages, remove only
full-metadata rows introduced by the target commit and preserve later rows even
when row numbers drifted. The recovery must support dry-run and must refuse
ambiguous database matches.

## Alternatives Rejected

- Keep the 462 bare pages. This makes invalid entity resolution durable and
  contradicts the current writer's guard.
- Revert files only. This leaves fence-owned fact coordinates pointing at
  missing or reverted markdown.
- Delete all facts for affected pages. This can destroy unrelated facts that
  existed before the migration.

## Components

- `src/commands/migrations/v0_32_2.ts`: slug guard, dry-run reporting, and
  collision-safe transactional stamping.
- `test/migrations-v0_32_2.test.ts`: regression coverage for bare slugs,
  partial-run retry duplicates, and non-matching slot occupants.
- `scripts/recover-v0322-partial-migration.ts`: commit-scoped, dry-run-first
  production recovery that applies its manifest to the current tree without
  deleting later facts.
- `test/recover-v0322-partial-migration.test.ts`: manifest/diff and recovery
  decision tests without production access.

## Safety And Verification

The recovery script performs no write without one explicit phase flag. It
verifies the target commit and source, prints exact counts, locks selected rows,
and uses expected-state predicates in one database transaction. `--write-db`
recovers only the database. After verification, `--write-files` refuses to run
unless the database postcondition is complete, then applies retry-safe file
edits. Focused tests run red then green, followed by typecheck, the complete
migration test set, repository verification, a production dry-run, the scoped
recovery, sync, migration rerun, and final database/filesystem consistency
checks.
