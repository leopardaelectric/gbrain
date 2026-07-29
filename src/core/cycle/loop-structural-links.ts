import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { Page } from '../types.ts';

const LOOP_REGISTRY_SLUG = 'loops/registry';
const LOOP_INDEX_RE = /^loops\/([^/]+)\/index$/;
const LOOP_RUN_RE = /^loops\/([^/]+)\/runs\/([^/]+)$/;
const LINK_SOURCE = 'maintenance';

function bySourceThenSlug(a: Page, b: Page): number {
  return a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug);
}

export function buildLoopStructuralLinksFromPages(pages: Page[]): LinkBatchInput[] {
  const bySource = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.slug.startsWith('loops/')) continue;
    const bucket = bySource.get(page.source_id) ?? [];
    bucket.push(page);
    bySource.set(page.source_id, bucket);
  }

  const links: LinkBatchInput[] = [];
  const sourceIds = Array.from(bySource.keys()).sort();
  for (const sourceId of sourceIds) {
    const sourcePages = (bySource.get(sourceId) ?? []).sort(bySourceThenSlug);
    const slugs = new Set(sourcePages.map((p) => p.slug));
    const hasRegistry = slugs.has(LOOP_REGISTRY_SLUG);
    const loopIndexes = new Map<string, string>();
    const loopRuns: Array<{ loop: string; run: string; slug: string }> = [];

    for (const page of sourcePages) {
      const indexMatch = LOOP_INDEX_RE.exec(page.slug);
      if (indexMatch) {
        loopIndexes.set(indexMatch[1], page.slug);
        continue;
      }
      const runMatch = LOOP_RUN_RE.exec(page.slug);
      if (runMatch) {
        loopRuns.push({ loop: runMatch[1], run: runMatch[2], slug: page.slug });
      }
    }

    const loopNames = Array.from(loopIndexes.keys()).sort();
    if (hasRegistry) {
      for (const loop of loopNames) {
        links.push({
          from_slug: LOOP_REGISTRY_SLUG,
          to_slug: loopIndexes.get(loop)!,
          link_type: 'catalogs_loop',
          link_source: LINK_SOURCE,
          context: `loop registry catalogs ${loop}`,
          from_source_id: sourceId,
          to_source_id: sourceId,
        });
      }
    }

    loopRuns.sort((a, b) => a.loop.localeCompare(b.loop) || a.run.localeCompare(b.run));
    for (const item of loopRuns) {
      const indexSlug = loopIndexes.get(item.loop);
      if (!indexSlug) continue;
      links.push({
        from_slug: indexSlug,
        to_slug: item.slug,
        link_type: 'contains_run',
        link_source: LINK_SOURCE,
        context: `loop ${item.loop} contains run ${item.run}`,
        from_source_id: sourceId,
        to_source_id: sourceId,
      });
    }
  }

  return links;
}

export async function materializeLoopStructuralLinks(
  engine: BrainEngine,
): Promise<{ links_created: number; links_considered: number; pages_scanned: number }> {
  const pages = await engine.listPages({ slugPrefix: 'loops/', limit: 100000 });
  const links = buildLoopStructuralLinksFromPages(pages);
  const linksCreated = links.length > 0
    ? await engine.addLinksBatch(links, { auditSite: 'addLinksBatch' }) // gbrain-allow-direct-insert: deterministic structural-link reconciler derived entirely from loop Markdown pages
    : 0;
  return {
    links_created: linksCreated,
    links_considered: links.length,
    pages_scanned: pages.length,
  };
}
