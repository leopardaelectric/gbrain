# GBrain Quality Signals Design

## Objective

Improve answer quality and operator trust without gaming health scores or deleting knowledge automatically.

## Design

The work has three independent lanes:

1. **Truthful signals.** Advisor installation detection will treat a skill directory containing `SKILL.md` as installed, while preserving legacy receipt detection. Doctor JSON will expose the weighted knowledge-composition score separately from the legacy all-check penalty score. Human output will label the legacy score explicitly.
2. **Conversation quality.** The parser will normalize the daily Slack archive block format (`## ISO timestamp`, metadata, message body) into the canonical inline-date format. Doctor will include bounded unmatched-slug samples for diagnosis. Existing formats remain unchanged.
3. **Graph hygiene and chronology.** Orphan policy will recognize the conventional `default/` namespace before applying intake-page exclusions. Junk-hub diagnostics will split auto-mention edges from curated edges. No pages or links will be deleted automatically. After code verification, live operations will establish retrieval baselines, backfill facts and chronology, and enable the nightly quality probe.

## Safety

- All code changes use focused red-green tests.
- Parser normalization requires a strict Slack archive signature.
- Orphan exclusions change reporting only; they do not delete or unlink pages.
- Junk-hub work remains diagnostic until each destructive cleanup target is reviewed.
- Live backfills use existing bounded job controls and explicit cost caps.

## Success criteria

- Advisor no longer recommends skills already present in the workspace.
- Doctor distinguishes knowledge composition from check-penalty scores in JSON and text.
- Current daily Slack archive pages parse deterministically.
- Orphan reporting excludes `default/inbox/` intake pages.
- Junk-hub findings show mention-derived versus curated edge counts.
- Retrieval baseline, nightly probe, facts backfill, and chronicle backfill have verified receipts.
