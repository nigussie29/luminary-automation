// Test harness: fresh in-memory Postgres (PGlite) per suite, controllable clock,
// fake email/AI that can be told to fail, and the real Express app on a random port.
import { createDb } from '../server/db/index.js';
import { createAi } from '../server/ai/index.js';
import { createServices } from '../server/services.js';
import { createApp } from '../server/app.js';
import { createIdentity, DEMO_USERS } from '../server/auth.js';
import { loadConfig } from '../server/config.js';

export const [OWNER_A, STAFF_A, OWNER_B] = DEMO_USERS;

export async function setup({ plan = 'pilot' } = {}) {
  const config = loadConfig({ CRON_SECRET: 'test-secret' }); // no Supabase/AI/email keys -> demo + simulated
  const db = await createDb({ databaseUrl: '' });
  let now = new Date('2026-10-19T14:00:00Z');
  const clock = () => new Date(now);
  const advanceHours = (h) => { now = new Date(now.getTime() + h * 3_600_000); };
  const setNow = (iso) => { now = new Date(iso); };

  const realAi = createAi(config);
  const ai = { ...realAi, failNext: 0,
    async analyze(a) { if (ai.failNext > 0) { ai.failNext -= 1; throw new Error('Simulated AI outage (503)'); } return realAi.analyze(a); },
    async draft(a) { if (ai.failNext > 0) { ai.failNext -= 1; throw new Error('Simulated AI outage (503)'); } return realAi.draft(a); },
  };
  const sent = [];
  const email = { live: false, fail: false,
    async send(m) { if (email.fail) throw new Error('SMTP 550 mailbox unavailable'); if (!m.to) throw new Error('Lead has no email address'); sent.push(m); return { mode: 'simulated', id: `t${sent.length}` }; },
  };
  const identity = await createIdentity(config);
  const services = createServices({ db, ai, email, identity, clock });
  const app = createApp({ services, identity, config, integrations: {} });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  // Two tutoring centers with knowledge bases.
  const mkWs = async (name, slug, owner, kb) => {
    const [ws] = await db.query(`insert into workspaces (name, slug, plan) values ($1,$2,$3) returning *`, [name, slug, plan]);
    await db.query(`insert into memberships values ($1,$2,$3,'owner')`, [ws.id, owner.id, owner.email]);
    for (const [kind, title, content] of kb) await db.query('insert into knowledge_items (workspace_id, kind, title, content) values ($1,$2,$3,$4)', [ws.id, kind, title, content]);
    return ws;
  };
  const wsA = await mkWs('Bright Path Tutoring', 'bright-path', OWNER_A, [
    ['service', '1-on-1 Tutoring', 'Private sessions for grades 3-12.'],
    ['service', 'SAT/ACT Prep', '12-session test-prep program.'],
    ['price', '1-on-1 Tutoring price', '$65 per hour.'],
    ['hours', 'Center hours', 'Mon-Thu 3-8 pm, Sat 9 am-2 pm.'],
  ]);
  await db.query(`insert into memberships values ($1,$2,$3,'staff')`, [wsA.id, STAFF_A.id, STAFF_A.email]);
  const wsB = await mkWs('Summit Learning', 'summit-learning', OWNER_B, [['service', 'Homework Help', 'Grades 1-8.']]);

  async function http(method, path, { user, ws, body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { authorization: `Bearer demo:${user.id}` } : {}), ...(ws ? { 'x-workspace-id': ws.id } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const events = (wsId, action) => db.query(`select * from automation_events where workspace_id=$1 ${action ? 'and action=$2' : ''} order by created_at`, action ? [wsId, action] : [wsId]);

  return {
    db, services, ai, email, sent, http, events, clock, advanceHours, setNow, wsA, wsB,
    ctxA: { userId: OWNER_A.id, workspaceId: wsA.id, role: 'owner' },
    async close() { server.close(); await db.close(); },
  };
}
