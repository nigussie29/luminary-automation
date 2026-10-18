// Business logic. Every function that touches tenant data takes `ctx = { userId, workspaceId, role }`
// (resolved from the authenticated user's membership by the API layer) and scopes EVERY query by
// ctx.workspaceId. Records from other workspaces return 404, never 403, so their existence isn't leaked.
import { HttpError, notFound } from './errors.js';
import {
  canTransition, isOpenStage, remindersOnLeadCreated, followUpReminders, appointmentReminders, PLANS, TIMING,
} from './rules.js';
import { checkDraft, hasBlockingFlags } from './ai/guardrails.js';
import { heuristicAnalyze, templateDraft } from './ai/index.js';
import { reminderMessage } from './templates.js';

const J = (v) => JSON.stringify(v ?? null);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : null) || null;

export function createServices({ db, ai, email, identity, clock = () => new Date() }) {
  const q = (sql, params) => db.query(sql, params);
  const one = async (sql, params) => (await q(sql, params))[0];
  const nowIso = () => clock().toISOString();

  // ------------------------------------------------------------ helpers
  async function logEvent(workspaceId, leadId, actor, action, status, detail = {}) {
    try {
      await q(`insert into automation_events (workspace_id, lead_id, actor, action, status, detail, created_at)
               values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)`,
      [workspaceId, leadId, String(actor), action, status, J(detail), nowIso()]);
    } catch (e) { console.error('[events] failed to record event', action, e.message); }
  }
  const requireOwner = (ctx) => { if (ctx.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can do this'); };
  const getWs = (id) => one('select * from workspaces where id = $1', [id]);
  const getKb = (wsId) => q('select * from knowledge_items where workspace_id = $1 and active order by kind, title', [wsId]);
  async function getLeadScoped(ctx, id) {
    const lead = await one('select * from leads where id = $1 and workspace_id = $2', [id, ctx.workspaceId]);
    if (!lead) throw notFound('Lead');
    return lead;
  }

  async function aiOpsThisMonth(wsId) {
    const r = await one(`select count(*)::int as n from ai_usage where workspace_id = $1 and created_at >= date_trunc('month', $2::timestamptz)`, [wsId, nowIso()]);
    return r.n;
  }
  async function overLimit(ws) { return (await aiOpsThisMonth(ws.id)) >= (PLANS[ws.plan]?.ai_ops ?? 0); }
  async function recordUsage(ws, leadId, operation, out) {
    await q(`insert into ai_usage (workspace_id, lead_id, operation, model, simulated, input_tokens, output_tokens, cost_usd_est, created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ws.id, leadId, operation, ai.model, out.simulated, out.usage.input_tokens || 0, out.usage.output_tokens || 0, out.usage.cost_usd || 0, nowIso()]);
  }

  async function scheduleReminders(wsId, leadId, items, appointmentId = null) {
    let created = 0;
    for (const r of items) {
      // ON CONFLICT DO NOTHING on (workspace_id, dedupe_key) = scheduling is idempotent.
      const rows = await q(`insert into reminders (workspace_id, lead_id, appointment_id, kind, due_at, dedupe_key, created_at)
                            values ($1,$2,$3,$4,$5,$6,$7) on conflict (workspace_id, dedupe_key) do nothing returning id`,
      [wsId, leadId, appointmentId, r.kind, r.due_at.toISOString(), r.dedupe_key, nowIso()]);
      created += rows.length;
    }
    return created;
  }
  async function cancelReminders(wsId, leadId, kinds, reason, appointmentId = null) {
    const rows = await q(`update reminders set status = 'cancelled', result = $4, processed_at = $5
                          where workspace_id = $1 and lead_id = $2 and status = 'pending' and kind = any($3::text[])
                            and ($6::uuid is null or appointment_id = $6) returning id`,
    [wsId, leadId, kinds, reason, nowIso(), appointmentId]);
    return rows.length;
  }

  async function insertMessage(ws, leadId, { purpose, subject, body, generated_by, missing_info = [], flags = [] }) {
    return one(`insert into messages (workspace_id, lead_id, purpose, subject, body, generated_by, missing_info, flags, created_at)
                values ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9) returning *`,
    [ws.id, leadId, purpose, subject, body, generated_by, J(missing_info), J(flags), nowIso()]);
  }

  /** Stage change with a conditional UPDATE (WHERE stage = from) so concurrent changes can't both win. */
  async function transitionLead(wsId, lead, to, actor, { reason } = {}) {
    if (lead.stage === to) return lead;
    if (!canTransition(lead.stage, to)) throw new HttpError(422, `Cannot move a lead from ${lead.stage} to ${to}`);
    const updated = await one(`update leads set stage = $3, updated_at = $4,
                                 enrolled_at = case when $3 = 'enrolled' then $4::timestamptz else enrolled_at end,
                                 closed_reason = case when $3 = 'closed' then $5 else null end
                               where id = $1 and workspace_id = $2 and stage = $6 returning *`,
    [lead.id, wsId, to, nowIso(), reason || null, lead.stage]);
    if (!updated) throw new HttpError(409, 'Lead was changed by someone else. Refresh and try again.');
    if (!isOpenStage(to)) {
      const n = await cancelReminders(wsId, lead.id, ['staff_respond_overdue', 'follow_up_1', 'follow_up_2', 'appointment_reminder', 'post_appointment'], `Lead ${to}`);
      if (n) await logEvent(wsId, lead.id, 'system', 'reminders.cancelled', 'success', { count: n, reason: `Lead ${to}` });
      // Automated nudges that haven't been sent yet no longer apply.
      const r = await q(`update messages set status='rejected', error=$3 where workspace_id=$1 and lead_id=$2 and status='pending_review'
                         and purpose in ('follow_up','appointment_reminder','post_appointment') returning id`, [wsId, lead.id, `Lead ${to}`]);
      if (r.length) await logEvent(wsId, lead.id, 'system', 'messages.withdrawn', 'success', { count: r.length, reason: `Lead ${to}` });
    }
    await logEvent(wsId, lead.id, actor, 'lead.stage_changed', 'success', { from: lead.stage, to, reason });
    return updated;
  }

  async function startFollowUpCycle(wsId, lead, anchorId) {
    const pending = await one(`select count(*)::int as n from reminders where workspace_id=$1 and lead_id=$2 and status='pending' and kind in ('follow_up_1','follow_up_2')`, [wsId, lead.id]);
    if (pending.n) return 0;
    const n = await scheduleReminders(wsId, lead.id, followUpReminders(lead.id, anchorId, clock()));
    if (n) await logEvent(wsId, lead.id, 'system', 'reminders.scheduled', 'success', { kinds: ['follow_up_1', 'follow_up_2'] });
    return n;
  }

  async function markResponded(wsId, lead) {
    await q('update leads set first_response_at = $3, updated_at = $3 where id = $1 and workspace_id = $2 and first_response_at is null', [lead.id, wsId, nowIso()]);
    await cancelReminders(wsId, lead.id, ['staff_respond_overdue'], 'Lead was contacted');
  }

  // ------------------------------------------------------------ AI steps
  async function draftFor(ws, lead, kb, purpose = 'first_response', actor = 'ai') {
    let draft; let generated_by; const extra = [];
    if (await overLimit(ws)) {
      draft = templateDraft({ lead, workspace: ws, kb }); generated_by = 'template';
      extra.push({ code: 'ai_limit_reached', severity: 'warn', message: 'Monthly AI limit reached for this plan; this is a rules-based template.' });
      await logEvent(ws.id, lead.id, 'system', 'ai.draft', 'skipped', { reason: 'plan_limit' });
    } else {
      try {
        const out = await ai.draft({ lead, workspace: ws, kb });
        await recordUsage(ws, lead.id, 'draft', out);
        draft = out.result; generated_by = out.simulated ? 'ai_simulated' : 'ai';
        await logEvent(ws.id, lead.id, actor, 'ai.draft', 'success', { simulated: out.simulated, model: ai.model, missing_info: draft.missing_info.length });
      } catch (e) {
        await logEvent(ws.id, lead.id, actor, 'ai.draft', 'error', { error: e.message });
        draft = templateDraft({ lead, workspace: ws, kb }); generated_by = 'template';
        extra.push({ code: 'ai_failed', severity: 'warn', message: 'AI drafting failed, so this is a rules-based template. Review carefully.' });
      }
    }
    const flags = [...checkDraft(draft.body, kb), ...extra];
    if (draft.missing_info?.length) {
      flags.push({ code: 'needs_staff_input', severity: 'warn', message: `${draft.missing_info.length} detail(s) the knowledge base could not answer — see "Missing information".` });
    }
    // A new draft supersedes any older unsent draft with the same purpose.
    await q(`update messages set status = 'rejected', error = 'Superseded by a newer draft' where workspace_id=$1 and lead_id=$2 and purpose=$3 and status='pending_review'`, [ws.id, lead.id, purpose]);
    const msg = await insertMessage(ws, lead.id, { purpose, subject: draft.subject, body: draft.body, generated_by, missing_info: draft.missing_info || [], flags });
    await logEvent(ws.id, lead.id, 'system', 'message.queued_for_review', 'success', { message_id: msg.id, generated_by, flags: flags.map((f) => f.code) });
    return msg;
  }

  async function processNewLead(leadId) {
    const lead0 = await one('select * from leads where id = $1', [leadId]);
    if (!lead0) return null;
    const ws = await getWs(lead0.workspace_id);
    const kb = await getKb(ws.id);
    const services = kb.filter((k) => k.kind === 'service');
    let analysis;
    if (await overLimit(ws)) {
      analysis = { ...heuristicAnalyze(lead0, services), method: 'rules', reason: 'plan_limit' };
      await logEvent(ws.id, leadId, 'system', 'ai.analyze', 'skipped', { reason: 'plan_limit' });
    } else {
      try {
        const out = await ai.analyze({ inquiry: lead0, services });
        await recordUsage(ws, leadId, 'analyze', out);
        analysis = { ...out.result, method: out.simulated ? 'simulated' : 'ai' };
        await logEvent(ws.id, leadId, 'ai', 'ai.analyze', 'success', { simulated: out.simulated, subject: analysis.subject, grade_level: analysis.grade_level, service: analysis.service });
      } catch (e) {
        analysis = { ...heuristicAnalyze(lead0, services), method: 'rules', error: e.message };
        await logEvent(ws.id, leadId, 'ai', 'ai.analyze', 'error', { error: e.message, fallback: 'rules' });
      }
    }
    const lead = await one(`update leads set subject = $2, grade_level = $3, service = $4, analysis = $5::text::jsonb, updated_at = $6 where id = $1 returning *`,
      [leadId, clip(analysis.subject, 80), clip(analysis.grade_level, 40), clip(analysis.service, 120), J(analysis), nowIso()]);
    if (analysis.spam) {
      await logEvent(ws.id, leadId, 'system', 'lead.flagged_spam', 'skipped', { note: 'No draft created; close the lead if this is spam.' });
      return { lead, message: null };
    }
    const message = await draftFor(ws, lead, kb);
    return { lead, message };
  }

  // ------------------------------------------------------------ public inquiry
  async function submitInquiry(slug, input, { deferProcessing = false } = {}) {
    const ws = await one('select * from workspaces where slug = $1', [String(slug || '').toLowerCase()]);
    if (!ws) throw notFound('Form');
    if (input.website) { // honeypot field humans never see
      await logEvent(ws.id, null, 'system', 'inquiry.rejected', 'skipped', { reason: 'honeypot' });
      return { ok: true };
    }
    const data = {
      parent_name: clip(input.parent_name, 120), student_name: clip(input.student_name, 120),
      email: clip(input.email, 200)?.toLowerCase() || null, phone: clip(input.phone, 40), message: clip(input.message, 5000),
    };
    // Optional context from embedded forms (e.g. the Luminary Academy track a student picked).
    const interest = clip(input.interest, 120);
    if (interest && data.message) data.message = `${data.message}\n\nInterested in: ${interest}`;
    if (!data.message || data.message.length < 5) throw new HttpError(400, 'Please describe what you are looking for.');
    if (!data.email && !data.phone) throw new HttpError(400, 'Please include an email address or phone number.');
    if (data.email && !EMAIL_RE.test(data.email)) throw new HttpError(400, 'Please enter a valid email address.');

    // Same family writing again while their lead is still open -> append to that lead, don't start a second workflow.
    if (data.email) {
      const dup = await one(`select * from leads where workspace_id=$1 and email=$2 and stage in ('new','contacted','appointment_booked')
                             and created_at > $3::timestamptz - make_interval(days => $4) order by created_at desc limit 1`,
      [ws.id, data.email, nowIso(), TIMING.duplicateInquiryDays]);
      if (dup) {
        await q(`update leads set message = message || $3, updated_at = $4 where id = $1 and workspace_id = $2`,
          [dup.id, ws.id, `\n\n--- Additional message (${nowIso().slice(0, 10)}) ---\n${data.message}`, nowIso()]);
        await logEvent(ws.id, dup.id, 'system', 'lead.duplicate_inquiry', 'skipped', { note: 'Appended to existing open lead; no new workflow started.' });
        return { ok: true, leadId: dup.id, duplicate: true };
      }
    }
    const lead = await one(`insert into leads (workspace_id, parent_name, student_name, email, phone, message, source, created_at, updated_at)
                            values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning *`,
    [ws.id, data.parent_name, data.student_name, data.email, data.phone, data.message, clip(input.source, 40) || 'web_form', nowIso()]);
    await logEvent(ws.id, lead.id, 'system', 'lead.created', 'success', { source: lead.source });
    await scheduleReminders(ws.id, lead.id, remindersOnLeadCreated(lead, ws));
    if (!deferProcessing) await processNewLead(lead.id);
    return { ok: true, leadId: lead.id, duplicate: false };
  }

  // ------------------------------------------------------------ leads
  async function listLeads(ctx, { q: search, stage, limit = 50, offset = 0 } = {}) {
    return q(`select l.id, l.parent_name, l.student_name, l.email, l.phone, l.subject, l.grade_level, l.service, l.stage,
                     l.created_at, l.first_response_at, l.source,
                     (select count(*)::int from messages m where m.lead_id = l.id and m.status = 'pending_review') as pending_messages,
                     (select min(a.starts_at) from appointments a where a.lead_id = l.id and a.status = 'scheduled') as next_appointment
              from leads l
              where l.workspace_id = $1 and ($2::text is null or l.stage = $2)
                and ($3::text is null or (coalesce(l.parent_name,'')||' '||coalesce(l.student_name,'')||' '||coalesce(l.email,'')||' '||
                     coalesce(l.phone,'')||' '||coalesce(l.subject,'')||' '||coalesce(l.grade_level,'')||' '||coalesce(l.service,'')||' '||l.message) ilike '%'||$3||'%')
              order by l.created_at desc limit $4 offset $5`,
    [ctx.workspaceId, stage || null, search ? String(search).slice(0, 100) : null, Math.min(Number(limit) || 50, 200), Number(offset) || 0]);
  }

  async function getLead(ctx, id) {
    const lead = await getLeadScoped(ctx, id);
    const [messages, appointments, reminders, events] = await Promise.all([
      q('select * from messages where lead_id=$1 and workspace_id=$2 order by created_at desc', [id, ctx.workspaceId]),
      q('select * from appointments where lead_id=$1 and workspace_id=$2 order by starts_at desc', [id, ctx.workspaceId]),
      q('select * from reminders where lead_id=$1 and workspace_id=$2 order by due_at', [id, ctx.workspaceId]),
      q('select * from automation_events where lead_id=$1 and workspace_id=$2 order by created_at desc, seq desc limit 100', [id, ctx.workspaceId]),
    ]);
    return { lead, messages, appointments, reminders, events };
  }

  async function updateLead(ctx, id, patch) {
    await getLeadScoped(ctx, id);
    const allowed = ['parent_name', 'student_name', 'email', 'phone', 'subject', 'grade_level', 'service'];
    const fields = allowed.filter((k) => k in patch);
    if (!fields.length) throw new HttpError(400, 'Nothing to update');
    if (patch.email && !EMAIL_RE.test(patch.email)) throw new HttpError(400, 'Invalid email');
    const sets = fields.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const lead = await one(`update leads set ${sets}, updated_at = now() where id = $1 and workspace_id = $2 returning *`,
      [id, ctx.workspaceId, ...fields.map((k) => clip(patch[k], 200))]);
    await logEvent(ctx.workspaceId, id, ctx.userId, 'lead.updated', 'success', { fields });
    return lead;
  }

  async function changeStage(ctx, id, to, { reason } = {}) {
    const lead = await getLeadScoped(ctx, id);
    if (to === 'appointment_booked') throw new HttpError(422, 'Use "Book appointment" so reminders are scheduled.');
    const updated = await transitionLead(ctx.workspaceId, lead, to, ctx.userId, { reason });
    if (to === 'contacted') { // e.g. staff phoned the family
      await markResponded(ctx.workspaceId, lead);
      await startFollowUpCycle(ctx.workspaceId, updated, `manual-${nowIso()}`);
    }
    return updated;
  }

  async function regenerateDraft(ctx, leadId) {
    const lead = await getLeadScoped(ctx, leadId);
    const ws = await getWs(ctx.workspaceId);
    return draftFor(ws, lead, await getKb(ws.id), lead.first_response_at ? 'manual' : 'first_response', ctx.userId);
  }

  // ------------------------------------------------------------ review queue
  const listQueue = (ctx) => q(`select m.*, l.parent_name, l.student_name, l.email, l.subject as lead_subject, l.grade_level, l.service, l.stage, l.message as inquiry
                                from messages m join leads l on l.id = m.lead_id
                                where m.workspace_id = $1 and m.status in ('pending_review','failed') order by m.created_at`, [ctx.workspaceId]);

  async function getMessageScoped(ctx, id) {
    const m = await one('select * from messages where id = $1 and workspace_id = $2', [id, ctx.workspaceId]);
    if (!m) throw notFound('Message');
    return m;
  }

  async function editMessage(ctx, id, { subject, body }) {
    const m = await getMessageScoped(ctx, id);
    if (!['pending_review', 'failed'].includes(m.status)) throw new HttpError(409, 'Only unsent messages can be edited');
    const newBody = clip(body, 10000) || m.body;
    const kb = await getKb(ctx.workspaceId);
    const kept = (m.flags || []).filter((f) => f.severity === 'warn');
    const flags = [...checkDraft(newBody, kb), ...kept];
    const updated = await one(`update messages set subject = $3, body = $4, flags = $5::text::jsonb where id = $1 and workspace_id = $2 returning *`,
      [id, ctx.workspaceId, clip(subject, 300) || m.subject, newBody, J(flags)]);
    await logEvent(ctx.workspaceId, m.lead_id, ctx.userId, 'message.edited', 'success', { message_id: id, flags: flags.map((f) => f.code) });
    return updated;
  }

  async function createManualMessage(ctx, leadId, { subject, body }) {
    const lead = await getLeadScoped(ctx, leadId);
    if (!body?.trim()) throw new HttpError(400, 'Message body is required');
    const kb = await getKb(ctx.workspaceId);
    const msg = await insertMessage({ id: ctx.workspaceId }, lead.id, {
      purpose: 'manual', subject: clip(subject, 300) || 'Following up', body: clip(body, 10000), generated_by: 'staff', flags: checkDraft(body, kb),
    });
    await logEvent(ctx.workspaceId, lead.id, ctx.userId, 'message.queued_for_review', 'success', { message_id: msg.id, generated_by: 'staff' });
    return msg;
  }

  async function rejectMessage(ctx, id) {
    const m = await getMessageScoped(ctx, id);
    const r = await one(`update messages set status='rejected', reviewed_by=$3, reviewed_at=$4 where id=$1 and workspace_id=$2 and status in ('pending_review','failed') returning *`,
      [id, ctx.workspaceId, ctx.userId, nowIso()]);
    if (!r) throw new HttpError(409, 'Message is no longer pending');
    await logEvent(ctx.workspaceId, m.lead_id, ctx.userId, 'message.rejected', 'success', { message_id: id });
    return r;
  }

  async function approveMessage(ctx, id, { acknowledgeFlags = false } = {}) {
    const m = await getMessageScoped(ctx, id);
    if (!['pending_review', 'failed'].includes(m.status)) throw new HttpError(409, `Message is already ${m.status}`);
    if (hasBlockingFlags(m.flags) && !acknowledgeFlags) {
      throw new HttpError(422, 'This draft has warnings that must be fixed or acknowledged before sending.', { flags: m.flags });
    }
    // Claim: only one approver can move it to 'approved' (prevents double sends on double-click / two staff).
    const claimed = await one(`update messages set status='approved', reviewed_by=$3, reviewed_at=$4, error=null
                               where id=$1 and workspace_id=$2 and status in ('pending_review','failed') returning *`,
    [id, ctx.workspaceId, ctx.userId, nowIso()]);
    if (!claimed) throw new HttpError(409, 'Message was already handled by someone else');
    if (hasBlockingFlags(m.flags)) await logEvent(ctx.workspaceId, m.lead_id, ctx.userId, 'message.flags_acknowledged', 'success', { message_id: id, flags: m.flags.map((f) => f.code) });

    const ws = await getWs(ctx.workspaceId);
    let lead = await one('select * from leads where id=$1 and workspace_id=$2', [m.lead_id, ctx.workspaceId]);
    try {
      const sent = await email.send({ to: lead.email, subject: claimed.subject, text: claimed.body, fromName: ws.reply_from || ws.name, replyTo: ws.reply_to });
      const done = await one(`update messages set status='sent', sent_at=$3, delivery_mode=$4 where id=$1 and workspace_id=$2 returning *`, [id, ctx.workspaceId, nowIso(), sent.mode]);
      await logEvent(ctx.workspaceId, lead.id, ctx.userId, 'message.sent', 'success', { message_id: id, delivery: sent.mode, provider_id: sent.id });
      await markResponded(ctx.workspaceId, lead);
      if (lead.stage === 'new') lead = await transitionLead(ctx.workspaceId, lead, 'contacted', 'system', { reason: 'First reply sent' });
      if (['first_response', 'manual'].includes(m.purpose) && lead.stage === 'contacted') await startFollowUpCycle(ctx.workspaceId, lead, id);
      return done;
    } catch (e) {
      const failed = await one(`update messages set status='failed', error=$3 where id=$1 and workspace_id=$2 returning *`, [id, ctx.workspaceId, e.message.slice(0, 500)]);
      await logEvent(ctx.workspaceId, lead.id, ctx.userId, 'message.sent', 'error', { message_id: id, error: e.message });
      return failed;
    }
  }

  // ------------------------------------------------------------ appointments
  async function bookAppointment(ctx, leadId, { starts_at, kind = 'consultation', notes }) {
    const lead = await getLeadScoped(ctx, leadId);
    if (!isOpenStage(lead.stage)) throw new HttpError(422, `Lead is ${lead.stage}; reopen it first.`);
    const start = new Date(starts_at);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Invalid appointment time');
    if (start <= clock()) throw new HttpError(400, 'Appointment time must be in the future');
    if (!['consultation', 'assessment', 'trial_session'].includes(kind)) throw new HttpError(400, 'Invalid appointment type');
    const appt = await one(`insert into appointments (workspace_id, lead_id, kind, starts_at, notes, created_by, created_at, updated_at)
                            values ($1,$2,$3,$4,$5,$6,$7,$7) returning *`,
    [ctx.workspaceId, lead.id, kind, start.toISOString(), clip(notes, 1000), ctx.userId, nowIso()]);
    await markResponded(ctx.workspaceId, lead);
    const updated = await transitionLead(ctx.workspaceId, lead, 'appointment_booked', 'system', { reason: 'Appointment booked' });
    const cancelled = await cancelReminders(ctx.workspaceId, lead.id, ['follow_up_1', 'follow_up_2'], 'Appointment booked');
    await scheduleReminders(ctx.workspaceId, lead.id, appointmentReminders(appt, clock()), appt.id);
    await logEvent(ctx.workspaceId, lead.id, ctx.userId, 'appointment.booked', 'success', { appointment_id: appt.id, starts_at: appt.starts_at, follow_ups_cancelled: cancelled });
    return { appointment: appt, lead: updated };
  }

  async function updateAppointment(ctx, id, { status, starts_at, notes }) {
    const appt = await one('select * from appointments where id=$1 and workspace_id=$2', [id, ctx.workspaceId]);
    if (!appt) throw notFound('Appointment');
    let lead = await one('select * from leads where id=$1 and workspace_id=$2', [appt.lead_id, ctx.workspaceId]);
    if (starts_at && appt.status === 'scheduled') {
      const start = new Date(starts_at);
      if (Number.isNaN(start.getTime()) || start <= clock()) throw new HttpError(400, 'New time must be a valid future time');
      const moved = await one('update appointments set starts_at=$3, updated_at=$4 where id=$1 and workspace_id=$2 returning *', [id, ctx.workspaceId, start.toISOString(), nowIso()]);
      await cancelReminders(ctx.workspaceId, lead.id, ['appointment_reminder', 'post_appointment'], 'Rescheduled', id);
      await scheduleReminders(ctx.workspaceId, lead.id, appointmentReminders(moved, clock()), id);
      await logEvent(ctx.workspaceId, lead.id, ctx.userId, 'appointment.rescheduled', 'success', { appointment_id: id, starts_at: moved.starts_at });
      return moved;
    }
    if (notes !== undefined) await q('update appointments set notes=$3 where id=$1 and workspace_id=$2', [id, ctx.workspaceId, clip(notes, 1000)]);
    if (!status || status === appt.status) return one('select * from appointments where id=$1', [id]);
    if (!['completed', 'no_show', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid status');
    if (appt.status !== 'scheduled') throw new HttpError(409, `Appointment is already ${appt.status}`);
    const updated = await one(`update appointments set status=$3, updated_at=$4 where id=$1 and workspace_id=$2 and status='scheduled' returning *`, [id, ctx.workspaceId, status, nowIso()]);
    if (!updated) throw new HttpError(409, 'Appointment was changed by someone else');
    await logEvent(ctx.workspaceId, lead.id, ctx.userId, `appointment.${status}`, 'success', { appointment_id: id });
    if (status !== 'completed') {
      await cancelReminders(ctx.workspaceId, lead.id, ['appointment_reminder', 'post_appointment'], `Appointment ${status}`, id);
      await q(`update messages set status='rejected', error=$3 where workspace_id=$1 and lead_id=$2 and status='pending_review' and purpose='appointment_reminder'`,
        [ctx.workspaceId, lead.id, `Appointment ${status}`]);
      const other = await one(`select count(*)::int as n from appointments where lead_id=$1 and workspace_id=$2 and status='scheduled'`, [lead.id, ctx.workspaceId]);
      if (lead.stage === 'appointment_booked' && !other.n) {
        lead = await transitionLead(ctx.workspaceId, lead, 'contacted', 'system', { reason: `Appointment ${status}` });
        await startFollowUpCycle(ctx.workspaceId, lead, `${id}-${status}`);
      }
    }
    return updated;
  }

  const listAppointments = (ctx, { upcoming = true } = {}) => q(
    `select a.*, l.parent_name, l.student_name, l.subject, l.grade_level, l.stage from appointments a join leads l on l.id = a.lead_id
     where a.workspace_id = $1 and ($2::boolean = false or a.starts_at >= $3::timestamptz - interval '2 days')
     order by a.starts_at limit 200`, [ctx.workspaceId, upcoming, nowIso()]);

  // ------------------------------------------------------------ reminder engine (programmed rules)
  async function executeReminder(rem) {
    const lead = await one('select * from leads where id=$1', [rem.lead_id]);
    const ws = await getWs(rem.workspace_id);
    if (!lead || !isOpenStage(lead.stage)) return { status: 'skipped', result: `Lead is ${lead?.stage || 'gone'}` };
    const appt = rem.appointment_id ? await one('select * from appointments where id=$1', [rem.appointment_id]) : null;
    const queueTemplate = async (kind) => {
      const tpl = reminderMessage(kind, { lead, ws, appt });
      const waiting = await one(`select count(*)::int as n from messages where lead_id=$1 and purpose=$2 and status='pending_review'`, [lead.id, tpl.purpose]);
      if (waiting.n) return { status: 'skipped', result: `A ${tpl.purpose.replace('_', ' ')} message is already waiting for review` };
      const kb = await getKb(ws.id);
      const msg = await insertMessage(ws, lead.id, { ...tpl, generated_by: 'template', flags: checkDraft(tpl.body, kb) });
      await logEvent(ws.id, lead.id, 'system', 'message.queued_for_review', 'success', { message_id: msg.id, generated_by: 'template', reminder: kind });
      return { status: 'done', result: `Queued ${tpl.purpose.replace('_', ' ')} message for review` };
    };
    switch (rem.kind) {
      case 'staff_respond_overdue':
        if (lead.stage === 'new' && !lead.first_response_at) {
          await logEvent(ws.id, lead.id, 'system', 'alert.respond_overdue', 'success', { hours: TIMING.respondOverdueHours });
          return { status: 'done', result: 'Flagged as overdue for a reply' };
        }
        return { status: 'skipped', result: 'Already contacted' };
      case 'follow_up_1':
      case 'follow_up_2': {
        if (lead.stage !== 'contacted') return { status: 'skipped', result: `Lead is ${lead.stage}` };
        return queueTemplate(rem.kind);
      }
      case 'appointment_reminder':
        if (!appt || appt.status !== 'scheduled') return { status: 'skipped', result: `Appointment is ${appt?.status || 'gone'}` };
        if (new Date(appt.starts_at) <= clock()) return { status: 'skipped', result: 'Appointment time has already passed' };
        return queueTemplate(rem.kind);
      case 'post_appointment':
        if (!appt) return { status: 'skipped', result: 'Appointment is gone' };
        if (appt.status === 'scheduled') {
          await logEvent(ws.id, lead.id, 'system', 'alert.attendance_needed', 'success', { appointment_id: appt.id });
          return { status: 'done', result: 'Asked staff to record whether the appointment happened' };
        }
        if (appt.status !== 'completed') return { status: 'skipped', result: `Appointment ${appt.status}` };
        return queueTemplate(rem.kind);
      default:
        throw new Error(`Unknown reminder kind ${rem.kind}`);
    }
  }

  async function runDueReminders({ limit = 100 } = {}) {
    const now = nowIso();
    // Recover reminders stuck in 'processing' (worker crashed) after 15 minutes.
    await q(`update reminders set status='pending' where status='processing' and processed_at < $1::timestamptz - interval '15 minutes'`, [now]);
    const due = await q(`select id from reminders where status='pending' and due_at <= $1 order by due_at limit $2`, [now, limit]);
    const results = [];
    for (const { id } of due) {
      // Atomic claim: if two workers race, only one UPDATE matches status='pending'.
      const rem = await one(`update reminders set status='processing', processed_at=$2 where id=$1 and status='pending' returning *`, [id, now]);
      if (!rem) continue;
      try {
        const r = await executeReminder(rem);
        await q('update reminders set status=$2, result=$3, processed_at=$4 where id=$1', [id, r.status, r.result, nowIso()]);
        await logEvent(rem.workspace_id, rem.lead_id, 'system', `reminder.${rem.kind}`, r.status === 'done' ? 'success' : 'skipped', { reminder_id: id, result: r.result });
        results.push({ id, kind: rem.kind, ...r });
      } catch (e) {
        await q(`update reminders set status='failed', result=$2, processed_at=$3 where id=$1`, [id, e.message.slice(0, 500), nowIso()]);
        await logEvent(rem.workspace_id, rem.lead_id, 'system', `reminder.${rem.kind}`, 'error', { reminder_id: id, error: e.message });
        results.push({ id, kind: rem.kind, status: 'failed', result: e.message });
      }
    }
    return { processed: results.length, results };
  }

  // ------------------------------------------------------------ automation history & dashboard
  const listEvents = (ctx, { status, limit = 100 } = {}) => q(
    `select e.*, l.parent_name, l.student_name from automation_events e left join leads l on l.id = e.lead_id
     where e.workspace_id = $1 and ($2::text is null or e.status = $2) order by e.created_at desc, e.seq desc limit $3`,
    [ctx.workspaceId, status || null, Math.min(Number(limit) || 100, 500)]);

  async function dashboard(ctx, { days = 30 } = {}) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    const now = nowIso();
    const ws = await getWs(ctx.workspaceId);
    const m = await one(`
      with l as (select * from leads where workspace_id = $1 and created_at >= $2::timestamptz - make_interval(days => $3))
      select count(*)::int as inquiries,
             count(*) filter (where first_response_at is not null)::int as responded,
             percentile_cont(0.5) within group (order by extract(epoch from (first_response_at - created_at)) / 60)
               filter (where first_response_at is not null) as median_response_minutes,
             (select count(distinct a.lead_id)::int from appointments a where a.lead_id in (select id from l)) as booked,
             count(*) filter (where enrolled_at is not null)::int as enrolled
      from l`, [ctx.workspaceId, now, d]);
    const stages = await q('select stage, count(*)::int as n from leads where workspace_id=$1 group by stage', [ctx.workspaceId]);
    const extra = await one(`select
        (select count(*)::int from messages where workspace_id=$1 and status='pending_review') as pending_review,
        (select count(*)::int from messages where workspace_id=$1 and status='failed') as failed_messages,
        (select count(*)::int from leads l where l.workspace_id=$1 and l.stage='new' and l.first_response_at is null
           and exists (select 1 from reminders r where r.lead_id=l.id and r.kind='staff_respond_overdue' and r.status='done')) as overdue,
        (select count(*)::int from automation_events where workspace_id=$1 and status='error' and created_at >= $2::timestamptz - interval '7 days') as errors_7d,
        (select count(*)::int from appointments where workspace_id=$1 and status='scheduled' and starts_at >= $2::timestamptz) as upcoming_appointments`,
    [ctx.workspaceId, now]);
    const usage = await one(`select count(*)::int as ops, coalesce(sum(input_tokens),0)::int as input_tokens,
        coalesce(sum(output_tokens),0)::int as output_tokens, coalesce(sum(cost_usd_est),0)::float as cost_usd,
        count(*) filter (where simulated)::int as simulated_ops
      from ai_usage where workspace_id=$1 and created_at >= date_trunc('month', $2::timestamptz)`, [ctx.workspaceId, now]);
    const daily = await q(`select to_char(day, 'YYYY-MM-DD') as day,
        (select count(*)::int from leads where workspace_id=$1 and created_at >= day and created_at < day + interval '1 day') as inquiries
      from generate_series(date_trunc('day', $2::timestamptz) - make_interval(days => $3 - 1), date_trunc('day', $2::timestamptz), interval '1 day') as day`,
    [ctx.workspaceId, now, Math.min(d, 60)]);
    const plan = PLANS[ws.plan];
    return {
      window_days: d,
      ...m,
      median_response_minutes: m.median_response_minutes == null ? null : Math.round(Number(m.median_response_minutes)),
      booking_rate: m.inquiries ? m.booked / m.inquiries : null,
      enrollment_rate: m.inquiries ? m.enrolled / m.inquiries : null,
      stages: Object.fromEntries(stages.map((s) => [s.stage, s.n])),
      ...extra,
      ai_usage: { ...usage, limit: plan.ai_ops, plan: ws.plan, plan_label: plan.label },
      daily,
    };
  }

  // ------------------------------------------------------------ workspace, knowledge base, members
  /** Lists the user's workspaces. First turns any pending invites for their VERIFIED email into memberships. */
  async function myWorkspaces(user) {
    if (user.email && user.emailVerified) {
      const email = user.email.toLowerCase();
      const claimed = await q(`insert into memberships (workspace_id, user_id, email, role)
                               select workspace_id, $1, email, role from member_invites where email = $2
                               on conflict (workspace_id, user_id) do nothing returning workspace_id`, [user.id, email]);
      await q('delete from member_invites where email = $1', [email]);
      for (const c of claimed) await logEvent(c.workspace_id, null, user.id, 'member.joined', 'success', { email });
    }
    return q(`select w.id, w.name, w.slug, w.plan, m.role from memberships m join workspaces w on w.id = m.workspace_id
              where m.user_id = $1 order by w.created_at`, [user.id]);
  }
  async function resolveContext(userId, workspaceId) {
    const m = await one('select role, email from memberships where user_id=$1 and workspace_id=$2', [userId, workspaceId]);
    if (!m) throw new HttpError(403, 'You are not a member of this workspace');
    return { userId, workspaceId, role: m.role, email: m.email };
  }
  async function createWorkspace(user, { name, slug }) {
    const s = String(slug || '').toLowerCase().trim();
    if (!clip(name, 120)) throw new HttpError(400, 'Name is required');
    if (!/^[a-z0-9-]{3,48}$/.test(s)) throw new HttpError(400, 'Form address may use 3-48 lowercase letters, numbers and dashes');
    if (await one('select 1 from workspaces where slug=$1', [s])) throw new HttpError(409, 'That form address is taken');
    const ws = await one('insert into workspaces (name, slug) values ($1,$2) returning *', [clip(name, 120), s]);
    await q(`insert into memberships (workspace_id, user_id, email, role) values ($1,$2,$3,'owner')`, [ws.id, user.id, user.email]);
    await logEvent(ws.id, null, user.id, 'workspace.created', 'success', {});
    return ws;
  }
  async function getWorkspace(ctx) { return getWs(ctx.workspaceId); }
  async function updateWorkspace(ctx, patch) {
    requireOwner(ctx);
    const allowed = ['name', 'timezone', 'reply_from', 'reply_to', 'booking_link'];
    const fields = allowed.filter((k) => k in patch);
    if ('open_days' in patch || 'open_hour' in patch || 'close_hour' in patch) {
      const cur = await getWs(ctx.workspaceId);
      const days = [...new Set((patch.open_days ?? cur.open_days).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      const open = Number(patch.open_hour ?? cur.open_hour);
      const close = Number(patch.close_hour ?? cur.close_hour);
      if (!days.length) throw new HttpError(400, 'Choose at least one open day');
      if (!(Number.isInteger(open) && Number.isInteger(close) && open >= 0 && close <= 24 && open < close)) throw new HttpError(400, 'Closing time must be after opening time');
      await q('update workspaces set open_days=$2, open_hour=$3, close_hour=$4 where id=$1', [ctx.workspaceId, days, open, close]);
      if (!fields.length) {
        await logEvent(ctx.workspaceId, null, ctx.userId, 'workspace.updated', 'success', { fields: ['business_hours'] });
        return getWs(ctx.workspaceId);
      }
    }
    if (!fields.length) return getWs(ctx.workspaceId);
    if (patch.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone }); } catch { throw new HttpError(400, 'Unknown time zone'); } }
    if (patch.booking_link && !/^https:\/\//.test(patch.booking_link)) throw new HttpError(400, 'Booking link must start with https://');
    const sets = fields.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const ws = await one(`update workspaces set ${sets} where id = $1 returning *`, [ctx.workspaceId, ...fields.map((k) => clip(patch[k], 300))]);
    await logEvent(ctx.workspaceId, null, ctx.userId, 'workspace.updated', 'success', { fields });
    return ws;
  }
  const listKnowledge = (ctx) => q('select * from knowledge_items where workspace_id=$1 order by kind, title', [ctx.workspaceId]);
  async function saveKnowledge(ctx, item) {
    requireOwner(ctx);
    if (!['service', 'price', 'hours', 'faq', 'policy'].includes(item.kind)) throw new HttpError(400, 'Invalid kind');
    if (!clip(item.title, 200) || !clip(item.content, 4000)) throw new HttpError(400, 'Title and content are required');
    const row = item.id
      ? await one(`update knowledge_items set kind=$3, title=$4, content=$5, active=$6, updated_at=now() where id=$1 and workspace_id=$2 returning *`,
        [item.id, ctx.workspaceId, item.kind, clip(item.title, 200), clip(item.content, 4000), item.active !== false])
      : await one(`insert into knowledge_items (workspace_id, kind, title, content) values ($1,$2,$3,$4) returning *`,
        [ctx.workspaceId, item.kind, clip(item.title, 200), clip(item.content, 4000)]);
    if (!row) throw notFound('Knowledge item');
    await logEvent(ctx.workspaceId, null, ctx.userId, 'knowledge.saved', 'success', { id: row.id, kind: row.kind });
    return row;
  }
  async function deleteKnowledge(ctx, id) {
    requireOwner(ctx);
    const r = await q('delete from knowledge_items where id=$1 and workspace_id=$2 returning id', [id, ctx.workspaceId]);
    if (!r.length) throw notFound('Knowledge item');
    return { ok: true };
  }
  async function listMembers(ctx) {
    requireOwner(ctx);
    return q(`select user_id, email, role, created_at, false as pending from memberships where workspace_id=$1
              union all
              select null, email, role, created_at, true from member_invites where workspace_id=$1
              order by pending, created_at`, [ctx.workspaceId]);
  }
  /** Records an invite. The person joins automatically the first time they sign in with this (verified) email. */
  async function addMember(ctx, { email: addr, role = 'staff' }) {
    requireOwner(ctx);
    const e = String(addr || '').toLowerCase().trim();
    if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Invalid email');
    if (!['owner', 'staff'].includes(role)) throw new HttpError(400, 'Invalid role');
    const ws = await getWs(ctx.workspaceId);
    if (await one('select 1 from memberships where workspace_id=$1 and email=$2', [ctx.workspaceId, e])) throw new HttpError(409, 'That person is already on the team');
    const count = await one(`select (select count(*) from memberships where workspace_id=$1) + (select count(*) from member_invites where workspace_id=$1) as n`, [ctx.workspaceId]);
    if (Number(count.n) >= PLANS[ws.plan].seats) throw new HttpError(402, `Your plan includes ${PLANS[ws.plan].seats} seats`);
    await q(`insert into member_invites (workspace_id, email, role, invited_by) values ($1,$2,$3,$4)
             on conflict (workspace_id, email) do update set role = excluded.role`, [ctx.workspaceId, e, role, ctx.userId]);
    await logEvent(ctx.workspaceId, null, ctx.userId, 'member.invited', 'success', { email: e, role });
    return { email: e, role, pending: true };
  }
  async function cancelInvite(ctx, addr) {
    requireOwner(ctx);
    const r = await q('delete from member_invites where workspace_id=$1 and email=$2 returning email', [ctx.workspaceId, String(addr || '').toLowerCase()]);
    if (!r.length) throw notFound('Invite');
    return { ok: true };
  }
  async function removeMember(ctx, userId) {
    requireOwner(ctx);
    if (userId === ctx.userId) throw new HttpError(400, 'You cannot remove yourself');
    const r = await q('delete from memberships where workspace_id=$1 and user_id=$2 returning user_id', [ctx.workspaceId, userId]);
    if (!r.length) throw notFound('Member');
    await logEvent(ctx.workspaceId, null, ctx.userId, 'member.removed', 'success', { user_id: userId });
    return { ok: true };
  }
  async function publicForm(slug) {
    const ws = await one('select name, slug from workspaces where slug=$1', [String(slug || '').toLowerCase()]);
    if (!ws) throw notFound('Form');
    return ws;
  }

  return {
    submitInquiry, processNewLead, listLeads, getLead, updateLead, changeStage, regenerateDraft,
    listQueue, editMessage, createManualMessage, approveMessage, rejectMessage,
    bookAppointment, updateAppointment, listAppointments, runDueReminders, listEvents, dashboard,
    myWorkspaces, resolveContext, createWorkspace, getWorkspace, updateWorkspace,
    listKnowledge, saveKnowledge, deleteKnowledge, listMembers, addMember, cancelInvite, removeMember, publicForm,
    logEvent,
  };
}
