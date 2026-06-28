import { describe, expect, test } from 'bun:test';
import { buildLoopStructuralLinksFromPages } from '../src/core/cycle/loop-structural-links.ts';
import type { Page } from '../src/core/types.ts';

function page(slug: string, source_id = 'default'): Page {
  return {
    id: 1,
    slug,
    source_id,
    type: 'page',
    title: slug,
    compiled_truth: '',
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('loop structural links', () => {
  test('builds deterministic registry and run links for indexed loops', () => {
    const links = buildLoopStructuralLinksFromPages([
      page('loops/registry'),
      page('loops/stock-delivery-ops-loop/index'),
      page('loops/stock-delivery-ops-loop/runs/2026-06-28-report'),
      page('loops/stock-delivery-ops-loop/runs/2026-06-29-report'),
      page('loops/no-index/runs/2026-06-28-report'),
      page('notes/not-a-loop'),
    ]);

    expect(links).toEqual([
      {
        from_slug: 'loops/registry',
        to_slug: 'loops/stock-delivery-ops-loop/index',
        link_type: 'catalogs_loop',
        link_source: 'maintenance',
        context: 'loop registry catalogs stock-delivery-ops-loop',
        from_source_id: 'default',
        to_source_id: 'default',
      },
      {
        from_slug: 'loops/stock-delivery-ops-loop/index',
        to_slug: 'loops/stock-delivery-ops-loop/runs/2026-06-28-report',
        link_type: 'contains_run',
        link_source: 'maintenance',
        context: 'loop stock-delivery-ops-loop contains run 2026-06-28-report',
        from_source_id: 'default',
        to_source_id: 'default',
      },
      {
        from_slug: 'loops/stock-delivery-ops-loop/index',
        to_slug: 'loops/stock-delivery-ops-loop/runs/2026-06-29-report',
        link_type: 'contains_run',
        link_source: 'maintenance',
        context: 'loop stock-delivery-ops-loop contains run 2026-06-29-report',
        from_source_id: 'default',
        to_source_id: 'default',
      },
    ]);
  });

  test('does not cross-link pages that share slugs across sources', () => {
    const links = buildLoopStructuralLinksFromPages([
      page('loops/registry', 'default'),
      page('loops/registry', 'alt'),
      page('loops/churn-loop/index', 'default'),
      page('loops/churn-loop/index', 'alt'),
      page('loops/churn-loop/runs/2026-06-28-report', 'alt'),
    ]);

    expect(links).toEqual([
      expect.objectContaining({
        from_slug: 'loops/registry',
        to_slug: 'loops/churn-loop/index',
        from_source_id: 'alt',
        to_source_id: 'alt',
      }),
      expect.objectContaining({
        from_slug: 'loops/churn-loop/index',
        to_slug: 'loops/churn-loop/runs/2026-06-28-report',
        from_source_id: 'alt',
        to_source_id: 'alt',
      }),
      expect.objectContaining({
        from_slug: 'loops/registry',
        to_slug: 'loops/churn-loop/index',
        from_source_id: 'default',
        to_source_id: 'default',
      }),
    ]);
  });
});
