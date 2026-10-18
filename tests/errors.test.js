// Failures are recorded in the automation history and never lose the lead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('AI outage: lead is still saved, error is recorded, a flagged template draft is queued', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  env.ai.failNext = 2; // both analyze and draft fail
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'a@example.com', message: '6th grade math help' });
  const { lead, messages } = await env.services.getLead(env.ctxA, leadId);
  assert.equal(lead.subject, 'Math', 'rules-based fallback still classified the inquiry');
  assert.equal(lead.analysis.method, 'rules');
  const errs = await env.events(env.wsA.id);
  assert.deepEqual(errs.filter((e) => e.status === 'error').map((e) => e.action).sort(), ['ai.analyze', 'ai.draft']);
  assert.match(errs.find((e) => e.action === 'ai.draft').detail.error, /outage/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].generated_by, 'template');
  assert.ok(messages[0].flags.some((f) => f.code === 'ai_failed'));
});

test('email failure: message marked failed with the reason, stage unchanged, and it can be retried', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'b@example.com', message: 'SAT prep, junior' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  env.email.fail = true;
  const r = await env.services.approveMessage(env.ctxA, messages[0].id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /550/);
  let { lead } = await env.services.getLead(env.ctxA, leadId);
  assert.equal(lead.stage, 'new');
  assert.equal(lead.first_response_at, null);
  const ev = await env.events(env.wsA.id, 'message.sent');
  assert.equal(ev[0].status, 'error');
  env.email.fail = false;
  const retry = await env.services.approveMessage(env.ctxA, messages[0].id);
  assert.equal(retry.status, 'sent');
  ({ lead } = await env.services.getLead(env.ctxA, leadId));
  assert.equal(lead.stage, 'contacted');
});

test('a lead with no email: sending fails clearly instead of silently', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { leadId } = await env.services.submitInquiry('bright-path', { phone: '555-0100', message: 'Call me about reading help' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  const r = await env.services.approveMessage(env.ctxA, messages[0].id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /no email/i);
});

test('a reminder that throws is marked failed and recorded; the others still run', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const a = await env.services.submitInquiry('bright-path', { email: 'c@example.com', message: 'math help please' });
  const b = await env.services.submitInquiry('bright-path', { email: 'd@example.com', message: 'reading help please' });
  await env.db.query(`update reminders set kind='follow_up_1', dedupe_key='broken' where lead_id=$1`, [a.leadId]);
  await env.db.query(`alter table reminders drop constraint reminders_kind_check`);
  await env.db.query(`update reminders set kind='not_a_real_kind' where lead_id=$1`, [a.leadId]);
  env.advanceHours(3);
  const r = await env.services.runDueReminders();
  assert.equal(r.processed, 2);
  const failed = r.results.find((x) => x.status === 'failed');
  assert.match(failed.result, /Unknown reminder kind/);
  assert.ok(r.results.some((x) => x.status === 'done'), 'the healthy reminder still ran');
  const ev = (await env.events(env.wsA.id)).filter((e) => e.status === 'error');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].lead_id, a.leadId);
  void b;
});

test('invalid public submissions are rejected with a clear message and honeypot spam is dropped', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const bad = await env.http('POST', '/public/forms/bright-path/inquiries', { body: { message: 'hi there' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /email address or phone/);
  const bot = await env.http('POST', '/public/forms/bright-path/inquiries', { body: { email: 'bot@spam.com', message: 'buy now', website: 'http://spam' } });
  assert.equal(bot.status, 201);
  assert.equal((await env.db.query('select count(*)::int as n from leads'))[0].n, 0);
  assert.equal((await env.http('POST', '/public/forms/nope/inquiries', { body: { email: 'a@b.co', message: 'hello' } })).status, 404);
});
