// End-to-end: inquiry -> recorded -> AI analysis -> AI draft -> staff approval -> sent ->
// stage Contacted -> follow-ups scheduled -> appointment booked -> reminders -> enrolled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, STAFF_A } from './helpers.js';

test('an inquiry completes the full workflow through enrollment', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const { http, wsA, advanceHours, db } = env;
  const staff = { user: STAFF_A, ws: wsA };

  // 1. Prospective family submits the public form (no login).
  const submit = await http('POST', '/public/forms/bright-path/inquiries', { body: {
    parent_name: 'Lena Ortiz', student_name: 'Mateo', email: 'lena@example.com',
    message: 'My son is in 8th grade and struggling with algebra. Do you offer one-on-one tutoring after school?',
  } });
  assert.equal(submit.status, 201);
  await new Promise((r) => setTimeout(r, 300)); // processing runs right after the response

  // 2. Recorded + analysed.
  const leads = await http('GET', '/leads', staff);
  assert.equal(leads.body.length, 1);
  const leadId = leads.body[0].id;
  let detail = (await http('GET', `/leads/${leadId}`, staff)).body;
  assert.equal(detail.lead.stage, 'new');
  assert.equal(detail.lead.subject, 'Math');
  assert.equal(detail.lead.grade_level, 'Grade 8');
  assert.equal(detail.lead.service, '1-on-1 Tutoring');
  assert.ok(detail.reminders.some((r) => r.kind === 'staff_respond_overdue' && r.status === 'pending'));

  // 3. Draft is waiting in the review queue and uses only knowledge-base facts.
  const queue = (await http('GET', '/queue', staff)).body;
  assert.equal(queue.length, 1);
  const draft = queue[0];
  assert.equal(draft.purpose, 'first_response');
  assert.match(draft.body, /\$65 per hour/);
  assert.deepEqual(draft.flags.filter((f) => f.severity === 'block'), []);

  // 4. Staff approves -> sent -> stage becomes Contacted, response time recorded, follow-ups scheduled.
  advanceHours(0.5);
  const approved = await http('POST', `/messages/${draft.id}/approve`, { ...staff, body: {} });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'sent');
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].to, 'lena@example.com');
  detail = (await http('GET', `/leads/${leadId}`, staff)).body;
  assert.equal(detail.lead.stage, 'contacted');
  assert.ok(detail.lead.first_response_at);
  const kinds = (s) => detail.reminders.filter((r) => r.status === s).map((r) => r.kind).sort();
  assert.deepEqual(kinds('pending'), ['follow_up_1', 'follow_up_2']);
  assert.deepEqual(kinds('cancelled'), ['staff_respond_overdue']);

  // 5. Two days pass with no booking -> rules engine queues follow-up #1 for review.
  advanceHours(48);
  await env.services.runDueReminders();
  let q2 = (await http('GET', '/queue', staff)).body;
  assert.equal(q2.length, 1);
  assert.equal(q2[0].purpose, 'follow_up');
  assert.equal(q2[0].generated_by, 'template');

  // 6. Family books a consultation -> stage Appointment Booked, pending follow-up #2 cancelled,
  //    appointment reminders scheduled.
  const startsAt = new Date(env.clock().getTime() + 3 * 86_400_000).toISOString();
  const booked = await http('POST', `/leads/${leadId}/appointments`, { ...staff, body: { starts_at: startsAt, kind: 'consultation' } });
  assert.equal(booked.status, 201);
  assert.equal(booked.body.lead.stage, 'appointment_booked');
  detail = (await http('GET', `/leads/${leadId}`, staff)).body;
  assert.equal(detail.reminders.find((r) => r.kind === 'follow_up_2').status, 'cancelled');
  assert.ok(detail.reminders.some((r) => r.kind === 'appointment_reminder' && r.status === 'pending'));

  // 7. 24h before -> appointment reminder queued.
  advanceHours(48.5);
  await env.services.runDueReminders();
  q2 = (await http('GET', '/queue', staff)).body;
  assert.ok(q2.some((m) => m.purpose === 'appointment_reminder'));

  // 8. Appointment happens, staff marks it completed, then enrolls the student.
  const apptId = booked.body.appointment.id;
  advanceHours(25);
  assert.equal((await http('PATCH', `/appointments/${apptId}`, { ...staff, body: { status: 'completed' } })).body.status, 'completed');
  const enrolled = await http('POST', `/leads/${leadId}/stage`, { ...staff, body: { stage: 'enrolled' } });
  assert.equal(enrolled.body.stage, 'enrolled');

  // Enrolling cancels remaining automation and withdraws unsent nudges.
  const pending = await db.query(`select count(*)::int as n from reminders where lead_id=$1 and status='pending'`, [leadId]);
  assert.equal(pending[0].n, 0);
  const waiting = await db.query(`select count(*)::int as n from messages where lead_id=$1 and status='pending_review' and purpose <> 'first_response'`, [leadId]);
  assert.equal(waiting[0].n, 0);

  // 9. Dashboard reflects the funnel; history shows every step.
  const dash = (await http('GET', '/dashboard', staff)).body;
  assert.equal(dash.inquiries, 1);
  assert.equal(dash.booked, 1);
  assert.equal(dash.enrolled, 1);
  assert.equal(dash.median_response_minutes, 30);
  assert.equal(dash.ai_usage.ops, 2);
  const actions = (await http('GET', '/events', staff)).body.map((e) => e.action);
  for (const a of ['lead.created', 'ai.analyze', 'ai.draft', 'message.sent', 'lead.stage_changed', 'reminder.follow_up_1', 'appointment.booked', 'appointment.completed']) {
    assert.ok(actions.includes(a), `history includes ${a}`);
  }
});

test('lead list search and stage filter', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.services.submitInquiry('bright-path', { parent_name: 'Ana Silva', email: 'ana@example.com', message: 'SAT prep for my junior please' });
  await env.services.submitInquiry('bright-path', { parent_name: 'Ben Lee', email: 'ben@example.com', message: 'Chemistry help, 10th grade' });
  const staff = { user: STAFF_A, ws: env.wsA };
  assert.equal((await env.http('GET', '/leads?q=silva', staff)).body.length, 1);
  assert.equal((await env.http('GET', '/leads?q=chemistry', staff)).body.length, 1);
  assert.equal((await env.http('GET', '/leads?stage=new', staff)).body.length, 2);
  assert.equal((await env.http('GET', '/leads?stage=enrolled', staff)).body.length, 0);
});
