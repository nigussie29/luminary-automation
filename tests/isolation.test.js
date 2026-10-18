// One business can never read or change another business's records — enforced in the API,
// and again by Postgres Row Level Security for direct database access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER_A, STAFF_A, OWNER_B } from './helpers.js';

test('API: workspace B cannot see or change workspace A records', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { http, wsA, wsB } = env;
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'a@example.com', message: '8th grade algebra' });
  const msg = (await env.services.getLead(env.ctxA, leadId)).messages[0];
  const appt = await env.services.bookAppointment(env.ctxA, leadId, { starts_at: new Date(env.clock().getTime() + 86_400_000 * 2).toISOString() });
  const kb = (await env.services.listKnowledge(env.ctxA))[0];

  const B = { user: OWNER_B, ws: wsB };
  assert.equal((await http('GET', '/leads', B)).body.length, 0);
  assert.equal((await http('GET', '/queue', B)).body.length, 0);
  assert.equal((await http('GET', '/appointments', B)).body.length, 0);
  assert.equal((await http('GET', '/events', B)).body.length, 0);
  assert.equal((await http('GET', '/dashboard', B)).body.inquiries, 0);
  // Direct ID access returns 404 (existence is not revealed).
  assert.equal((await http('GET', `/leads/${leadId}`, B)).status, 404);
  assert.equal((await http('PATCH', `/leads/${leadId}`, { ...B, body: { parent_name: 'hacked' } })).status, 404);
  assert.equal((await http('POST', `/leads/${leadId}/stage`, { ...B, body: { stage: 'closed' } })).status, 404);
  assert.equal((await http('POST', `/messages/${msg.id}/approve`, { ...B, body: { acknowledgeFlags: true } })).status, 404);
  assert.equal((await http('PATCH', `/messages/${msg.id}`, { ...B, body: { body: 'hacked' } })).status, 404);
  assert.equal((await http('PATCH', `/appointments/${appt.appointment.id}`, { ...B, body: { status: 'cancelled' } })).status, 404);
  assert.equal((await http('PUT', `/knowledge/${kb.id}`, { ...B, body: { kind: 'price', title: 'x', content: '$1' } })).status, 404);

  // Pointing the workspace header at A without membership is refused.
  assert.equal((await http('GET', '/leads', { user: OWNER_B, ws: wsA })).status, 403);
  // No token at all.
  assert.equal((await http('GET', '/leads', { ws: wsA })).status, 401);

  // Nothing in A changed.
  const { lead, messages, appointments } = await env.services.getLead(env.ctxA, leadId);
  assert.notEqual(lead.parent_name, 'hacked');
  assert.equal(messages[0].status, 'pending_review');
  assert.equal(appointments[0].status, 'scheduled');
  assert.equal(env.sent.length, 0);
});

test('permissions: staff can work leads but cannot change the knowledge base, settings or members', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const S = { user: STAFF_A, ws: env.wsA };
  const O = { user: OWNER_A, ws: env.wsA };
  assert.equal((await env.http('GET', '/knowledge', S)).status, 200);
  assert.equal((await env.http('POST', '/knowledge', { ...S, body: { kind: 'price', title: 'Discount', content: '$10 off' } })).status, 403);
  assert.equal((await env.http('PATCH', '/workspace', { ...S, body: { name: 'Mine now' } })).status, 403);
  assert.equal((await env.http('GET', '/members', S)).status, 403);
  assert.equal((await env.http('POST', '/members', { ...S, body: { email: 'x@y.com' } })).status, 403);
  assert.equal((await env.http('POST', '/knowledge', { ...O, body: { kind: 'faq', title: 'Parking', content: 'Free lot behind the building.' } })).status, 201);
  assert.equal((await env.http('GET', '/members', O)).body.length, 2);
});

test('database RLS: a signed-in Supabase user can only read their own workspace and cannot write', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.services.submitInquiry('bright-path', { email: 'a@example.com', message: 'math help please' });
  await env.services.submitInquiry('summit-learning', { email: 'b@example.com', message: 'homework help please' });
  const { db } = env;
  // Simulate a request through Supabase's REST API as owner B (role `authenticated`, JWT sub = B).
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${OWNER_B.id}';`);
  try {
    const leads = await db.query('select workspace_id from leads');
    assert.equal(leads.length, 1);
    assert.equal(leads[0].workspace_id, env.wsB.id);
    assert.equal((await db.query('select * from knowledge_items where workspace_id=$1', [env.wsA.id])).length, 0);
    assert.equal((await db.query('select * from workspaces')).length, 1);
    await assert.rejects(db.query(`update leads set stage='closed'`), /permission denied/);
    await assert.rejects(db.query(`insert into memberships values ($1,$2,'x@y','owner')`, [env.wsA.id, OWNER_B.id]), /permission denied/);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub;');
  }
});
