# Fact consolidation health design

## Problem

Three independent defects make fact consolidation look broken or leave eligible facts stranded:

1. `gbrain doctor` asks for `getFactsHealth('default')`, so a multi-source brain whose facts live under another source reports zero recent facts.
2. `countUnconsolidatedFacts` counts audit receipts and other rows with no entity, even though the consolidator only scans rows whose `entity_slug` is present.
3. Legacy fallback entity slugs can have a real canonical page under a structured path, but the consolidator requires an exact page slug and never retries canonical resolution.

## Design

### Global doctor health

Extract the facts-health doctor check into a testable helper. Enumerate the source IDs that actually occur in `facts`, request the existing per-source health snapshot for each, aggregate the totals, and report the largest source counts. An empty facts table remains a valid all-zero state.

This keeps `BrainEngine.getFactsHealth` source-scoped and avoids changing its public contract.

### Actionable pending count

Define `pending_consolidation` as active, unconsolidated facts with a non-null entity slug. This mirrors the consolidator's bucket scan. Terminal `EXTRACTION_COMPLETE` audit receipts remain in `facts` as durable audit evidence but no longer pollute the actionable backlog.

### Legacy canonicalization during consolidation

Extend entity resolution with a conservative structured-path match:

- match a normalized entity token as a complete path segment;
- accept only a unique canonical leaf (`readme`, `index`, or a direct page ending in the entity token);
- normalize common deployment wrappers such as `-prod` and duplicated prefixes such as `ms-ms-*`;
- otherwise preserve the existing fuzzy/fallback behavior.

When a consolidation bucket lacks an exact page, run the canonical resolver. If it returns a real page instead of `fallback_slugify`, migrate active unconsolidated facts in that bucket to the canonical slug before clustering and promote the resulting cluster into that page. Dry runs report the work without mutating facts.

The resolver never auto-creates pages. Ambiguous or genuinely page-less entities stay pending for curation.

## Safety and verification

- Regression tests cover multi-source doctor totals, terminal audit exclusion, structured-path resolution, deployment-name normalization, and legacy bucket migration.
- Targeted tests run red before production changes and green afterward.
- Full unit/type/verification gates run before completion.
- The production database is read only during diagnosis; no bulk Vammo API calls are involved.
