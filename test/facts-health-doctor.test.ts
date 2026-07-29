import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { checkFactsHealth } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name)
     VALUES ('mind-agent-brain', 'Mind Agent Brain')
     ON CONFLICT (id) DO NOTHING`,
  );

  await engine.insertFact(
    {
      fact: 'recent fact in the canonical source',
      kind: 'fact',
      entity_slug: 'projects/gbrain',
      source: 'test',
    },
    { source_id: 'mind-agent-brain' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('checkFactsHealth', () => {
  test('aggregates sources that actually contain facts instead of hardcoding default', async () => {
    const check = await checkFactsHealth(engine);

    expect(check.name).toBe('facts_health');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('1 active');
    expect(check.message).toContain('1 this week');
    expect(check.message).toContain('mind-agent-brain:1');
    expect(check.message).not.toContain('facts_health(default)');
  });
});
