# GBrain Quality Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GBrain health guidance truthful, parse Vammo Slack archives, improve graph diagnostics, and run bounded quality backfills.

**Architecture:** Keep signal fixes in their existing pure helpers, add one strict parser normalization path, and preserve compatibility through additive report fields. Live maintenance runs only after focused and full verification.

**Tech Stack:** TypeScript, Bun test, PostgreSQL-backed GBrain CLI, YAML schema pack.

---

### Task 1: Correct installed-skill detection

**Files:**
- Modify: `src/core/skillpack/post-install-advisory.ts`
- Test: `test/post-install-advisory.test.ts`

- [ ] Add a failing test that creates `skills/cold-start/SKILL.md` without a managed receipt and expects `detectInstalledSlugs()` to include `cold-start`.
- [ ] Run `bun test test/post-install-advisory.test.ts` and confirm the directory-owned skill test fails.
- [ ] Union receipt slugs with immediate child directories that contain `SKILL.md`.
- [ ] Run the focused test and confirm it passes.

### Task 2: Separate score meanings

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `test/doctor-behavioral.test.ts`

- [ ] Add a failing report test with a `brain_score` check carrying `details.score: 86`; expect `knowledge_quality_score: 86` while `health_score` keeps legacy penalty math.
- [ ] Run the focused test and confirm the additive field is absent.
- [ ] Add `knowledge_quality_score: number | null` to `DoctorReport`, derive it from structured check details, and attach structured components to the `brain_score` check.
- [ ] Change human copy from “Overall health score” to “Legacy all-check penalty score.”
- [ ] Run doctor-focused tests.

### Task 3: Parse daily Slack archive blocks

**Files:**
- Modify: `src/core/conversation-parser/normalize-block.ts`
- Modify: `src/commands/doctor.ts`
- Test: `test/conversation-parser-normalize-block.test.ts`
- Test: `test/doctor-v0_41_13_checks.test.ts`

- [ ] Add a failing parser test using `## 2026-08-25T12:04:37.435Z`, Slack metadata, and a Portuguese message body.
- [ ] Run the parser test and confirm `phase: no_match`.
- [ ] Implement strict archive-block detection and normalization to `**Speaker** (YYYY-MM-DD HH:MM): text`.
- [ ] Add a failing doctor test expecting bounded `details.unmatched_slugs` on low coverage.
- [ ] Add bounded diagnostic details without changing the warning threshold.
- [ ] Run parser and doctor-focused tests.

### Task 4: Improve orphan and hub diagnostics

**Files:**
- Modify: `src/core/orphan-policy.ts`
- Modify: `src/commands/doctor/checks/graph-embedding.ts`
- Test: `test/orphans-pure-fn.test.ts`
- Test: `test/junk-entity-guards.test.ts`

- [ ] Add a failing test showing `default/inbox/...` is not excluded.
- [ ] Apply first-segment rules after the conventional `default/` namespace.
- [ ] Add a failing junk-hub test expecting mention and curated edge counts.
- [ ] Extend the query and structured result with `mention_edges` and `curated_edges`.
- [ ] Run focused graph tests.

### Task 5: Verify code and run live maintenance

**Files:**
- Modify: `schema-packs/vammo-company-brain/pack.yaml` in the company-brain repository after validation.

- [ ] Run focused tests, typecheck, diff check, and the full unit suite.
- [ ] Run the updated CLI against the live brain and confirm Advisor, Doctor, parser coverage, orphans, and hub diagnostics.
- [ ] Record a retrieval baseline with the existing whoknows fixture.
- [ ] Add a conservative Portuguese/English `works_at` inference regex to the Vammo schema pack and validate it before activation.
- [ ] Enable the nightly quality probe.
- [ ] Submit the bounded facts backfill with a USD 5 cap.
- [ ] Run chronicle backfill and verify queued/completed counts.
- [ ] Re-run Doctor and Advisor and record before/after values.
