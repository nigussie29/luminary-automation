// The AI must not invent prices/availability; missing facts are surfaced to staff instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, STAFF_A } from './helpers.js';
import { checkDraft } from '../server/ai/guardrails.js';
import { remindersOnLeadCreated, followUpReminders, canTransition } from '../server/rules.js';

const KB = [{ kind: 'price', title: 'Tutoring', content: '$65 per hour; 10-hour package $600.' }];

test('guardrails flag prices that are not in the knowledge base', () => {
  assert.deepEqual(checkDraft('Sessions are $65 per hour.', KB), []);
  assert.deepEqual(checkDraft('Sessions are $65/hour or $600 for ten.', KB), []);
  const f = checkDraft('SAT prep costs $1,500.', KB);
  assert.equal(f[0].code, 'unverified_price');
  assert.equal(f[0].severity, 'block');
  assert.equal(checkDraft('Good news, we have an opening Tuesday at 4!', KB)[0].code, 'availability_claim');
  assert.equal(checkDraft('Hi [Name], thanks', KB)[0].code, 'placeholder');
});

test('when a price is missing, the draft omits it and lists it as missing information', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  // SAT/ACT Prep exists as a service, but the KB has no SAT price.
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'p@example.com', message: 'How much is SAT prep? My daughter is a junior.' });
  const { lead, messages } = await env.services.getLead(env.ctxA, leadId);
  assert.equal(lead.service, 'SAT/ACT Prep');
  const m = messages[0];
  assert.doesNotMatch(m.body, /\$\d/);
  assert.ok(m.missing_info.some((x) => /price/i.test(x)));
  assert.ok(m.flags.some((f) => f.code === 'needs_staff_input'));
});

test('when grade or subject is unknown, the draft asks the family', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'q@example.com', message: 'Hello, interested in your services.' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  assert.match(messages[0].body, /What grade is your student in\?/);
  assert.match(messages[0].body, /Which subject/);
});

test('a staff edit that adds an unapproved price blocks sending until fixed or acknowledged', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 'r@example.com', message: '8th grade algebra tutoring' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  const S = { user: STAFF_A, ws: env.wsA };
  const edited = await env.http('PATCH', `/messages/${messages[0].id}`, { ...S, body: { body: `${messages[0].body}\nSpecial offer: $40 per hour this month!` } });
  assert.ok(edited.body.flags.some((f) => f.code === 'unverified_price'));
  const blocked = await env.http('POST', `/messages/${messages[0].id}/approve`, { ...S, body: {} });
  assert.equal(blocked.status, 422);
  assert.equal(env.sent.length, 0);
  const forced = await env.http('POST', `/messages/${messages[0].id}/approve`, { ...S, body: { acknowledgeFlags: true } });
  assert.equal(forced.body.status, 'sent');
  assert.equal((await env.events(env.wsA.id, 'message.flags_acknowledged')).length, 1, 'override is audited');
});

test('plan AI limit: drafting falls back to templates and the skip is recorded', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.db.query(`insert into ai_usage (workspace_id, operation, model, simulated, created_at)
                      select $1, 'draft', 'x', true, $2 from generate_series(1, 400)`, [env.wsA.id, env.clock().toISOString()]);
  const { leadId } = await env.services.submitInquiry('bright-path', { email: 's@example.com', message: 'math help please' });
  const { messages } = await env.services.getLead(env.ctxA, leadId);
  assert.equal(messages[0].generated_by, 'template');
  assert.ok(messages[0].flags.some((f) => f.code === 'ai_limit_reached'));
  assert.equal((await env.events(env.wsA.id)).filter((e) => e.status === 'skipped' && e.action.startsWith('ai.')).length, 2);
});

test('stage rules and reminder timing are deterministic', () => {
  assert.ok(canTransition('new', 'contacted'));
  assert.ok(!canTransition('enrolled', 'new'));
  assert.ok(!canTransition('new', 'enrolled'));
  const [r] = remindersOnLeadCreated({ id: 'L1', created_at: '2026-10-19T14:00:00Z' });
  assert.equal(r.due_at.toISOString(), '2026-10-19T16:00:00.000Z');
  const f = followUpReminders('L1', 'M1', new Date('2026-10-19T14:00:00Z'));
  assert.deepEqual(f.map((x) => x.dedupe_key), ['follow_up_1:L1:M1', 'follow_up_2:L1:M1']);
});
