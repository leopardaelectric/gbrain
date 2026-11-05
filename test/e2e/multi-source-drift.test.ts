import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { checkDriftSourceIsolation, checkLargeDriftProbe } from '../helpers/multi-source-drift-cases.ts';

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('multi-source drift array binding on Postgres', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });
  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  test('isolates sources and excludes soft-deleted pages', async () => {
    await checkDriftSourceIsolation(engine);
  });

  test('more than 65,535 files use two parameters and one real query', async () => {
    await checkLargeDriftProbe(engine);
  }, 120_000);
});
