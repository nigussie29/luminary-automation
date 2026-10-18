// Database adapter. Two backends, one SQL dialect (Postgres):
//   * DATABASE_URL set  -> real Postgres (Supabase) via `pg`
//   * otherwise         -> PGlite (Postgres compiled to WASM) in-process, for demo mode and tests
// Both expose:  query(sql, params) -> rows
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');

export function migrationSql() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
}

// Supabase provides `auth.uid()` and the `authenticated` role. PGlite does not, so we stub them
// with the same behaviour (uid comes from the request.jwt.claim.sub setting, like PostgREST).
const SUPABASE_SHIM = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;
`;

export async function createDb({ databaseUrl = process.env.DATABASE_URL, dataDir } = {}) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_MAX || 5),
    });
    // Luminary Automation's tables live in the `automation` schema (shared Supabase project).
    pool.on('connect', (client) => { client.query('set search_path to automation, public').catch(() => {}); });
    return {
      kind: 'postgres',
      async query(sql, params = []) { return (await pool.query(sql, params)).rows; },
      async exec(sql) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = dataDir ? new PGlite(dataDir) : new PGlite();
  await pglite.waitReady;
  const db = {
    kind: 'pglite',
    raw: pglite,
    async query(sql, params = []) { return (await pglite.query(sql, params)).rows; },
    async exec(sql) { await pglite.exec(sql); },
    async close() { await pglite.close(); },
  };
  await db.exec(SUPABASE_SHIM);
  await db.exec('set search_path to automation, public');
  for (const sql of migrationSql()) await db.exec(sql);
  await db.exec('grant usage on schema automation to authenticated; grant select on all tables in schema automation to authenticated;');
  return db;
}
