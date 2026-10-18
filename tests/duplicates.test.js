// Duplicate follow-ups, duplicate sends and duplicate inquiries are prevented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, STAFF_A } from './helpers.js';

async function contactedLead(env) {
  const { leadId } = await env.services.submitInquiry('bright-path', { parent_name: 'Ana', email: 'ana@example.com', message: '7th grade math tutoring please' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  await env.services.approveMessage(env.ctxA, messages[0].id);
  return leadId;
}

test('running the reminder engine repeatedly or concurrently creates each follow-up once', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const leadId = await contactedLead(env);
  env.advanceHours(49);
  const [r1, r2] = await Promise.all([env.services.runDueReminders(), env.services.runDueReminders()]);
  await env.services.runDueReminders();
  assert.equal(r1.processed + r2.processed, 1, 'only one worker claimed the due reminder');
  const msgs = await env.db.query(`select * from messages where lead_id=$1 and purpose='follow_up'`, [leadId]);
  assert.equal(msgs.length, 1);
});

test('scheduling the same follow-up cycle twice does not create duplicate reminders', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const leadId = await contactedLead(env);
  // Staff marks Contacted again via a manual message; an existing cycle must not be duplicated.
  const m = await env.services.createManualMessage(env.ctxA, leadId, { subject: 'Hi', body: 'Just checking in.' });
  await env.services.approveMessage(env.ctxA, m.id);
  const rows = await env.db.query(`select kind, count(*)::int as n from reminders where lead_id=$1 and kind like 'follow_up%' group by kind`, [leadId]);
  assert.deepEqual(rows.map((r) => r.n), [1, 1]);
  // Direct re-insert of an identical reminder is rejected by the unique dedupe key.
  await assert.rejects(env.db.query(`insert into reminders (workspace_id, lead_id, kind, due_at, dedupe_key)
    select workspace_id, lead_id, kind, due_at, dedupe_key from reminders where lead_id=$1 limit 1`, [leadId]), /duplicate key/);
});

test('a follow-up is not queued while another follow-up is still waiting for review', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const leadId = await contactedLead(env);
  env.advanceHours(49); await env.services.runDueReminders(); // follow_up_1 queued, not reviewed
  env.advanceHours(80); await env.services.runDueReminders(); // follow_up_2 due
  const msgs = await env.db.query(`select * from messages where lead_id=$1 and purpose='follow_up' and status='pending_review'`, [leadId]);
  assert.equal(msgs.length, 1);
  const r2 = (await env.db.query(`select * from reminders where lead_id=$1 and kind='follow_up_2'`, [leadId]))[0];
  assert.equal(r2.status, 'skipped');
});

test('double-clicking approve sends the email only once', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'x@example.com', message: '9th grade geometry' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  const staff = { user: STAFF_A, ws: env.wsA, body: {} };
  const [a, b] = await Promise.all([
    env.http('POST', `/messages/${messages[0].id}/approve`, staff),
    env.http('POST', `/messages/${messages[0].id}/approve`, staff),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(env.sent.length, 1);
});

test('the same family writing again joins their open lead instead of starting a second workflow', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const first = await env.services.submitInquiry('bright-path', { email: 'Sam@Example.com', message: 'Need algebra help' });
  env.advanceHours(3);
  const second = await env.services.submitInquiry('bright-path', { email: 'sam@example.com', message: 'Also, do you do weekends?' });
  assert.equal(second.duplicate, true);
  assert.equal(second.leadId, first.leadId);
  const leads = await env.db.query('select * from leads');
  assert.equal(leads.length, 1);
  assert.match(leads[0].message, /weekends/);
  // Only one reply waits for review: the newer draft (covering both messages) replaced the older one.
  const drafts = await env.db.query(`select * from messages where purpose='first_response' and status='pending_review'`);
  assert.equal(drafts.length, 1);
});

test('when a family writes again, their new message gets a fresh draft in the review queue', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  // Before the first reply: the new draft replaces the old one (one pending first reply).
  const first = await env.services.submitInquiry('bright-path', { email: 'mum@example.com', message: 'Algebra help please' });
  await env.services.submitInquiry('bright-path', { email: 'mum@example.com', message: 'Also, is SAT prep available?' });
  let msgs = await env.db.query(`select * from messages where lead_id=$1 order by created_at`, [first.leadId]);
  assert.equal(msgs.filter((m) => m.status === 'pending_review').length, 1);
  assert.equal(msgs.at(-1).purpose, 'first_response');
  // After the first reply has been sent: an extra reply is queued for the new message.
  await env.services.approveMessage(env.ctxA, msgs.at(-1).id);
  env.advanceHours(5);
  await env.services.submitInquiry('bright-path', { email: 'mum@example.com', message: 'Can we start next week?' });
  msgs = await env.db.query(`select * from messages where lead_id=$1 and status='pending_review'`, [first.leadId]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].purpose, 'manual');
  assert.equal((await env.services.dashboard(env.ctxA)).pending_review, 1, 'shows under Needs you');
});
