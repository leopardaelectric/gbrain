import { describe, test, expect } from 'bun:test';
import { contentSanityBodyHash, contentSanityEventHash, reconcileContentSanityResolutions, type ContentSanityResolution } from '../src/core/audit/content-sanity-resolution.ts';
import type { ContentSanityAuditEvent } from '../src/core/audit/content-sanity-audit.ts';
const event: ContentSanityAuditEvent = { ts: '2026-01-01T00:00:00Z', event_type: 'quarantine', source_id: 'example', slug: 'sources/technical-example', bytes: 42, junk_pattern_matches: ['access_denied'], literal_substring_matches: [], reason_messages: ['PAGE_JUNK_PATTERN access_denied'] };
const page = { source_id: 'example', content_hash: 'abc', title: 'Technical observation', compiled_truth: 'Technical observation about retry policy.', timeline: '', frontmatter: {} };
const resolution: ContentSanityResolution = { ts: '2026-01-02T00:00:00Z', event_sha256: contentSanityEventHash(event), source_id: 'example', slug: event.slug, content_hash: 'abc', body_sha256: contentSanityBodyHash(page.compiled_truth, ''), code_revision: 'a'.repeat(40), evidence_ref: 'reports/verified-remediation', reason: 'false_positive_corrected' };
const engine = (p: any = page) => ({ getPage: async (slug: string, opts: any) => { expect(slug).toBe(event.slug); expect(opts).toEqual({ sourceId: 'example' }); return p; } });
describe('content sanity resolution requires exact evidence and safe live content', () => {
  test('no acknowledgment keeps original hard event unresolved', async () => {
    expect(await reconcileContentSanityResolutions(engine(), [event], [])).toEqual({ resolved: [], unresolved: [resolution.event_sha256] });
  });
  test('verified acknowledgment resolves without mutating original event', async () => {
    const before = JSON.stringify(event);
    expect(await reconcileContentSanityResolutions(engine(), [event], [resolution])).toEqual({ resolved: [resolution.event_sha256], unresolved: [] });
    expect(JSON.stringify(event)).toBe(before);
  });
  for (const delta of [{ source_id: 'other' }, { slug: 'other' }, { event_sha256: '0'.repeat(64) }, { body_sha256: '0'.repeat(64) }, { content_hash: 'other' }, { code_revision: 'not-a-revision' }, { evidence_ref: '' }, { ts: '2025-01-01T00:00:00Z' }, { ts: '2099-01-01T00:00:00Z' }]) {
    test(`invalid acknowledgment stays unresolved: ${JSON.stringify(delta)}`, async () => {
      expect((await reconcileContentSanityResolutions(engine(), [event], [{ ...resolution, ...delta }])).unresolved).toHaveLength(1);
    });
  }
  for (const p of [null, { ...page, source_id: 'other' }, { ...page, frontmatter: { quarantine: {} } }, { ...page, content_hash: 'changed' }, { ...page, compiled_truth: 'Changed after acknowledgment' }]) {
    test(`missing/quarantined/changed live page stays unresolved: ${JSON.stringify(p)}`, async () => {
      expect((await reconcileContentSanityResolutions(engine(p), [event], [resolution])).unresolved).toHaveLength(1);
    });
  }
  test('arbitrary matching acknowledgment cannot hide actual live denial', async () => {
    const p = { ...page, title: 'Access denied', compiled_truth: 'Access denied to this resource' };
    const r = { ...resolution, body_sha256: contentSanityBodyHash(p.compiled_truth, '') };
    expect((await reconcileContentSanityResolutions(engine(p), [event], [r])).unresolved).toHaveLength(1);
  });
  test('operator literal remains fail closed', async () => {
    expect((await reconcileContentSanityResolutions(engine(), [event], [resolution], [{ name: 'operator-example', substring: 'Technical observation' }])).unresolved).toHaveLength(1);
  });
  test('failed database recheck stays unresolved', async () => {
    expect((await reconcileContentSanityResolutions({ getPage: async () => { throw Error('DB unavailable'); } }, [event], [resolution])).unresolved).toHaveLength(1);
  });
  test('another hard event cannot borrow the acknowledgment', async () => {
    const other = { ...event, ts: '2026-01-01T00:00:01Z' };
    const result = await reconcileContentSanityResolutions(engine(), [event, other], [resolution]);
    expect(result.resolved).toHaveLength(1); expect(result.unresolved).toHaveLength(1);
  });
});
