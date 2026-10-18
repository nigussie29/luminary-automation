// Applies supabase/migrations/*.sql to DATABASE_URL. Safe to run on every deploy:
// the schema uses IF NOT EXISTS / CREATE OR REPLACE and policies are dropped and recreated.
import 'dotenv/config';
import { createDb, migrationSql } from './index.js';

if (!process.env.DATABASE_URL) {
  console.log('[migrate] DATABASE_URL not set — skipping (demo mode uses in-process PGlite).');
  process.exit(0);
}
const db = await createDb();
for (const sql of migrationSql()) await db.exec(sql);
console.log('[migrate] schema up to date');
await db.close();
