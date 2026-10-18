// Code paths that only run in production: Supabase-verified sign-in, staff invites,
// business-hours alerts, and the real Postgres wire protocol (`pg` driver + migrations).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { setup, STAFF_A } from './helpers.js';
import { createIdentity } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { createServices } from '../server/services.js';
import { createAi } from '../server/ai/index.js';
import { createDb, migrationSql } from '../server/db/index.js';
import { loadConfig } from '../server/config.js';
import { addBusinessHours } from '../server/rules.js';

// ---------------------------------------------------------------- business hours
test('reply alert counts only open hours, in the center time zone', () => {
  const ws = { timezone: 'America/New_York', open_days: [1, 2, 3, 4, 5, 6], open_hour: 9, close_hour: 19 };
  // Monday 10:00 ET (EDT, UTC-4) -> 12:00 ET
  assert.equal(addBusinessHours('2026-10-19T14:00:00Z', 2, ws).toISOString(), '2026-10-19T16:00:00.000Z');
  // Monday 18:00 ET -> 1h Monday + 1h Tuesday = Tuesday 10:00 ET
  assert.equal(addBusinessHours('2026-10-19T22:00:00Z', 2, ws).toISOString(), '2026-10-20T14:00:00.000Z');
  // Saturday 21:00 ET -> closed Sunday -> Monday 11:00 ET
  assert.equal(addBusinessHours('2026-10-25T01:00:00Z', 2, ws).toISOString(), '2026-10-26T15:00:00.000Z');
});

test('a Saturday-night inquiry is not flagged overdue until Monday', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  env.setNow('2026-10-25T01:00:00Z'); // Sat 9 pm in New York
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'late@example.com', message: 'Algebra help for my 9th grader' });
  const [r] = await env.db.query(`select * from reminders where lead_id=$1 and kind='staff_respond_overdue'`, [leadId]);
  assert.equal(new Date(r.due_at).toISOString(), '2026-10-26T15:00:00.000Z');
  env.setNow('2026-10-26T12:00:00Z'); // Monday 8 am: still not due
  assert.equal((await env.services.runDueReminders()).processed, 0);
  env.setNow('2026-10-26T15:05:00Z');
  assert.equal((await env.services.runDueReminders()).results[0].status, 'done');
  assert.equal((await env.services.dashboard(env.ctxA)).overdue, 1);
});

test('owner can change business hours; staff cannot; invalid hours are rejected', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const ok = await env.http('PATCH', '/workspace', { user: { id: env.ctxA.userId }, ws: env.wsA, body: { open_days: [1, 2, 3, 4], open_hour: 15, close_hour: 20 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.open_days.map(Number), [1, 2, 3, 4]);
  assert.equal((await env.http('PATCH', '/workspace', { user: { id: env.ctxA.userId }, ws: env.wsA, body: { open_hour: 20, close_hour: 9 } })).status, 400);
  assert.equal((await env.http('PATCH', '/workspace', { user: STAFF_A, ws: env.wsA, body: { open_hour: 8 } })).status, 403);
});

// ---------------------------------------------------------------- invites
test('staff invite: joins on first sign-in with a VERIFIED matching email only', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const inv = await env.services.addMember(env.ctxA, { email: 'New.Tutor@Center.com' });
  assert.equal(inv.pending, true);
  assert.ok((await env.services.listMembers(env.ctxA)).some((m) => m.pending && m.email === 'new.tutor@center.com'));
  const id = crypto.randomUUID();
  assert.equal((await env.services.myWorkspaces({ id, email: 'new.tutor@center.com', emailVerified: false })).length, 0, 'unverified email cannot claim');
  assert.equal((await env.services.myWorkspaces({ id: crypto.randomUUID(), email: 'someone.else@center.com', emailVerified: true })).length, 0);
  const ws = await env.services.myWorkspaces({ id, email: 'NEW.TUTOR@center.com', emailVerified: true });
  assert.equal(ws.length, 1);
  assert.equal(ws[0].role, 'staff');
  assert.equal(ws[0].id, env.wsA.id);
  assert.equal((await env.services.myWorkspaces({ id, email: 'new.tutor@center.com', emailVerified: true })).length, 1, 'idempotent');
  assert.ok(!(await env.services.listMembers(env.ctxA)).some((m) => m.pending));
  await assert.rejects(env.services.addMember({ ...env.ctxA, role: 'staff' }, { email: 'x@y.com' }), /owner/);
  await assert.rejects(env.services.addMember(env.ctxA, { email: 'new.tutor@center.com' }), /already on the team/);
});

test('seat limit counts pending invites', async (t) => {
  const env = await setup(); // pilot plan: 3 seats; owner + staff already = 2
  t.after(() => env.close());
  await env.services.addMember(env.ctxA, { email: 'third@center.com' });
  await assert.rejects(env.services.addMember(env.ctxA, { email: 'fourth@center.com' }), /3 seats/);
  await env.services.cancelInvite(env.ctxA, 'third@center.com');
  await env.services.addMember(env.ctxA, { email: 'fourth@center.com' });
});

// ---------------------------------------------------------------- Supabase sign-in path
function fakeSupabaseAuth(users) {
  // Mimics GET {SUPABASE_URL}/auth/v1/user, which supabase-js calls in auth.getUser(token).
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const u = users[token];
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/auth/v1/user') && u) { res.end(JSON.stringify({ id: u.id, aud: 'authenticated', email: u.email, email_confirmed_at: u.verified ? '2026-10-01T00:00:00Z' : null })); return; }
    res.statusCode = 401;
    res.end(JSON.stringify({ code: 401, msg: 'invalid JWT' }));
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

test('live mode: Supabase tokens are verified server-side and demo sign-in is disabled', async (t) => {
  const owner = { id: crypto.randomUUID(), email: 'owner@realcenter.com', verified: true };
  const auth = await fakeSupabaseAuth({ 'tok-owner': owner });
  const config = loadConfig({ SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_ANON_KEY: 'anon-key' });
  assert.equal(config.demoAuth, false);
  const identity = await createIdentity(config);
  const db = await createDb({ databaseUrl: '' });
  const services = createServices({ db, ai: createAi(config), email: { live: false, async send() { return { mode: 'simulated', id: 'x' }; } }, identity });
  const app = createApp({ services, identity, config, integrations: {} });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(async () => { server.close(); auth.close(); await db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (path, token, opts = {}) => fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });

  assert.equal((await call('/me', 'tok-owner')).status, 200);
  assert.equal((await call('/me', 'forged-token')).status, 401);
  assert.equal((await call('/me', 'demo:00000000-0000-4000-8000-00000000a001')).status, 401, 'demo tokens are useless in live mode');
  assert.equal((await call('/demo/users')).status, 404);
  assert.equal((await call('/demo/run-reminders', 'tok-owner', { method: 'POST' })).status, 404);
  const status = await (await call('/status')).json();
  assert.equal(status.demo, false);
  assert.equal(status.supabase.anonKey, 'anon-key');

  // New real user creates a workspace and becomes its owner.
  const created = await call('/workspaces', 'tok-owner', { method: 'POST', body: JSON.stringify({ name: 'Real Center', slug: 'real-center' }) });
  assert.equal(created.status, 201);
  const me = await (await call('/me', 'tok-owner')).json();
  assert.equal(me.workspaces[0].role, 'owner');
});

// ---------------------------------------------------------------- real Postgres wire protocol
test('pg driver + migrations + full workflow over the Postgres wire protocol', async (t) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const backing = await PGlite.create();
  // Supabase already has these; a bare Postgres needs them for the RLS policies.
  await backing.exec(`create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$; create role authenticated;`);
  const port = 50000 + Math.floor(Math.random() * 10000);
  const socket = new PGLiteSocketServer({ db: backing, port, host: '127.0.0.1' });
  await socket.start();
  process.env.DB_POOL_MAX = '1';
  const db = await createDb({ databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres` });
  t.after(async () => { await db.close(); await socket.stop(); await backing.close(); delete process.env.DB_POOL_MAX; });
  assert.equal(db.kind, 'postgres');

  for (const sql of migrationSql()) await db.exec(sql);
  for (const sql of migrationSql()) await db.exec(sql); // re-running on every deploy is safe

  const config = loadConfig({});
  const sent = [];
  const services = createServices({ db, ai: createAi(config), email: { async send(m) { sent.push(m); return { mode: 'simulated', id: 's' }; } }, identity: null });
  const [ws] = await db.query(`insert into workspaces (name, slug) values ('Wire Test', 'wire-test') returning *`);
  const owner = crypto.randomUUID();
  await db.query(`insert into memberships values ($1,$2,'o@w.com','owner')`, [ws.id, owner]);
  await db.query(`insert into knowledge_items (workspace_id, kind, title, content) values ($1,'service','1-on-1 Tutoring','Private sessions'),($1,'price','1-on-1 Tutoring price','$70 per hour')`, [ws.id]);
  const ctx = { userId: owner, workspaceId: ws.id, role: 'owner' };

  await services.updateWorkspace(ctx, { open_days: [1, 2, 3], open_hour: 14, close_hour: 20 }); // int[] parameter
  const { leadId } = await services.submitInquiry('wire-test', { parent_name: 'Kai', email: 'kai@example.com', message: '6th grade math tutoring, please' });
  const { lead, messages } = await services.getLead(ctx, leadId);
  assert.equal(lead.subject, 'Math');
  assert.match(messages[0].body, /\$70 per hour/);
  assert.ok(Array.isArray(messages[0].flags), 'jsonb round-trips as an array');
  const sentMsg = await services.approveMessage(ctx, messages[0].id);
  assert.equal(sentMsg.status, 'sent');
  assert.equal(sent.length, 1);
  const dash = await services.dashboard(ctx);
  assert.equal(dash.inquiries, 1);
  assert.equal(typeof dash.ai_usage.cost_usd, 'number');
  await services.addMember(ctx, { email: 'staff@w.com' });
  const claimed = await services.myWorkspaces({ id: crypto.randomUUID(), email: 'staff@w.com', emailVerified: true });
  assert.equal(claimed[0].role, 'staff');
});
