/** Append-only remediation acknowledgments. They never erase assessment events.
 * Acknowledgments are hints, not authority: doctor rechecks the exact live page,
 * source, content hash, body digest, quarantine state, and current assessor.
 * Unknown/missing/changed/unsafe content remains unresolved (fail closed).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assessContentSanity, type OperatorLiteral } from '../content-sanity.ts';
import { loadOperatorLiterals } from '../content-sanity-literals.ts';
import type { ContentSanityAuditEvent } from './content-sanity-audit.ts';
import { createAuditWriter } from './audit-writer.ts';

export interface ContentSanityResolution {
  ts: string;
  event_sha256: string;
  source_id: string;
  slug: string;
  content_hash: string;
  body_sha256: string;
  code_revision: string;
  evidence_ref: string;
  reason: 'false_positive_corrected' | 'source_remediated';
}
const writer = createAuditWriter<ContentSanityResolution>({ featureName: 'content-sanity-resolutions' });
export const readRecentContentSanityResolutions = (days = 7, now = new Date()): ContentSanityResolution[] => writer.readRecent(days, now);
export const logContentSanityResolution = (resolution: ContentSanityResolution): void => writer.log(resolution);
export const contentSanityBodyHash = (body: string, timeline: string): string =>
  createHash('sha256').update(JSON.stringify([body, timeline])).digest('hex');
export function contentSanityEventHash(event: ContentSanityAuditEvent): string {
  return createHash('sha256').update(JSON.stringify([
    event.ts, event.event_type, event.source_id, event.slug, event.bytes,
    event.junk_pattern_matches, event.literal_substring_matches, event.reason_messages,
    event.bypass_active === true,
  ])).digest('hex');
}
export const isHardContentSanityEvent = (event: ContentSanityAuditEvent): boolean =>
  ['hard_block', 'reject', 'quarantine'].includes(event.event_type);

export async function reconcileContentSanityResolutions(
  engine: Pick<BrainEngine, 'getPage'>,
  events: ReadonlyArray<ContentSanityAuditEvent>,
  resolutions: ReadonlyArray<ContentSanityResolution>,
  extraLiterals: ReadonlyArray<OperatorLiteral> = [],
): Promise<{ resolved: string[]; unresolved: string[] }> {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const event of events.filter(isHardContentSanityEvent)) {
    const hash = contentSanityEventHash(event);
    const candidates = resolutions.filter(r =>
      r.event_sha256 === hash && r.source_id === event.source_id && r.slug === event.slug &&
      !!r.source_id && !!r.slug && !!r.content_hash && /^[a-f0-9]{64}$/.test(r.body_sha256) &&
      /^[a-f0-9]{40}$/.test(r.code_revision) && typeof r.evidence_ref === 'string' && r.evidence_ref.trim().length > 0 &&
      ['false_positive_corrected', 'source_remediated'].includes(r.reason) &&
      Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) >= Date.parse(event.ts) && Date.parse(r.ts) <= Date.now(),
    );
    let safe = false;
    if (candidates.length) {
      try {
        const page = await engine.getPage(event.slug, { sourceId: event.source_id });
        if (page && !page.frontmatter?.quarantine && page.source_id === event.source_id) {
          const bodyHash = contentSanityBodyHash(page.compiled_truth, page.timeline ?? '');
          if (candidates.some(r => r.content_hash === page.content_hash && r.body_sha256 === bodyHash)) {
            safe = !assessContentSanity({
              compiled_truth: page.compiled_truth, timeline: page.timeline ?? '', title: page.title,
              extra_literals: extraLiterals,
            }).shouldHardBlock;
          }
        }
      } catch { /* a failed recheck must never acknowledge a hard event */ }
    }
    (safe ? resolved : unresolved).push(hash);
  }
  return { resolved, unresolved };
}

/** Local doctor entry point; all proof validation stays in the narrow module. */
export async function resolveRecentContentSanityEvents(engine: Pick<BrainEngine, 'getPage'>, events: ReadonlyArray<ContentSanityAuditEvent>): Promise<{ resolved: string[]; unresolved: string[] }> {
  return reconcileContentSanityResolutions(engine, events, readRecentContentSanityResolutions(7), loadOperatorLiterals());
}
