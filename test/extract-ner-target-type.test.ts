import { describe, expect, test } from 'bun:test';
import { parseSchemaPackManifest } from '../src/core/schema-pack/index.ts';
import { inferNerLinkType } from '../src/core/extract-ner.ts';
import * as extractNer from '../src/core/extract-ner.ts';

describe('inferNerLinkType target_type scope', () => {
  const pack = parseSchemaPackManifest({
    api_version: 'gbrain-schema-pack-v1',
    name: 'target-scoped-ner',
    version: '0.1.0',
    extends: null,
    page_types: [
      { name: 'person', primitive: 'entity', path_prefixes: ['people/'] },
      { name: 'company', primitive: 'entity', path_prefixes: ['companies/'] },
    ],
    link_types: [{
      name: 'works_at',
      inference: {
        target_type: 'company',
        regex: '\\b(works? at|trabalha (?:na|no))\\b',
      },
    }],
  });

  test('matches the regex only when the mentioned target has the declared type', () => {
    const context = 'Joao trabalha na Vammo';
    expect(inferNerLinkType(pack, 'company', context)).toBe('works_at');
    expect(inferNerLinkType(pack, 'person', context)).toBeNull();
  });

  test('only entity pages can own an inferred relationship', () => {
    const isEligibleNerSourceType = (extractNer as Record<string, unknown>).isEligibleNerSourceType;
    expect(typeof isEligibleNerSourceType).toBe('function');
    const isEligible = isEligibleNerSourceType as (type: string | undefined) => boolean;
    for (const type of ['person', 'company', 'organization', 'entity']) {
      expect(isEligible(type)).toBe(true);
    }
    for (const type of ['conversation', 'slack', 'report', 'note', 'project', undefined]) {
      expect(isEligible(type)).toBe(false);
    }
  });
});
