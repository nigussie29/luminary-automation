import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../session.jsx';
import { Empty, ErrorNote, PageHead, fmtDate, stageLabel } from '../ui.jsx';

const ACTION = {
  'lead.created': 'Inquiry recorded', 'lead.duplicate_inquiry': 'Family wrote again — message added to their lead', 'lead.updated': 'Lead details edited',
  'lead.stage_changed': 'Stage changed', 'lead.flagged_spam': 'Looks like spam — no draft created',
  'ai.analyze': 'AI read the inquiry', 'ai.draft': 'AI drafted a reply', 'message.queued_for_review': 'Message added to review queue',
  'message.edited': 'Message edited', 'message.sent': 'Message sent', 'message.rejected': 'Message discarded',
  'message.flags_acknowledged': 'Warnings overridden by reviewer', 'messages.withdrawn': 'Unsent follow-ups withdrawn',
  'reminders.scheduled': 'Follow-ups scheduled', 'reminders.cancelled': 'Reminders cancelled',
  'appointment.booked': 'Appointment booked', 'appointment.rescheduled': 'Appointment moved', 'appointment.completed': 'Appointment attended',
  'appointment.no_show': 'No-show recorded', 'appointment.cancelled': 'Appointment cancelled',
  'alert.respond_overdue': 'No reply after 2 open hours — flagged', 'alert.attendance_needed': 'Attendance not recorded — flagged',
  'reminder.follow_up_1': 'Follow-up #1 rule ran', 'reminder.follow_up_2': 'Follow-up #2 rule ran', 'reminder.appointment_reminder': 'Appointment reminder rule ran',
  'reminder.post_appointment': 'After-appointment rule ran', 'reminder.staff_respond_overdue': 'Reply-time check ran',
  'knowledge.saved': 'Knowledge base updated', 'workspace.updated': 'Settings updated', 'member.added': 'Team member added', 'member.removed': 'Team member removed',
  'workspace.created': 'Workspace created', 'member.invited': 'Team member invited', 'member.joined': 'Invited team member joined', 'inquiry.rejected': 'Spam submission blocked',
};
const STATUS = { success: 'text-done', error: 'text-brick font-semibold', skipped: 'text-slate' };

function describe(e) {
  const d = e.detail || {};
  if (e.action === 'lead.stage_changed') return `${stageLabel(d.from)} to ${stageLabel(d.to)}${d.reason ? ` (${d.reason})` : ''}`;
  if (d.error) return d.error;
  if (e.action === 'message.sent') return d.delivery === 'simulated' ? 'Simulated: not actually delivered' : 'Delivered to email provider';
  if (e.action.startsWith('ai.') && d.simulated) return 'Simulated AI (demo)';
  if (e.action.startsWith('ai.') && d.reason === 'plan_limit') return 'Skipped: monthly AI limit reached, used template';
  return d.result || d.note || d.reason || '';
}

export function EventRow({ e, showLead }) {
  return (
    <li className="flex gap-3 px-4 py-2.5 text-sm">
      <span className={`w-16 shrink-0 text-xs pt-0.5 ${STATUS[e.status]}`}>{e.status === 'success' ? 'Done' : e.status === 'error' ? 'Error' : 'Skipped'}</span>
      <span className="flex-1 min-w-0">
        {ACTION[e.action] || e.action}
        {showLead && e.lead_id && <> — <Link className="underline" to={`/leads/${e.lead_id}`}>{e.parent_name || 'lead'}</Link></>}
        {describe(e) && <span className="block text-xs text-slate break-words">{describe(e)}</span>}
      </span>
      <span className="text-xs text-slate whitespace-nowrap">{fmtDate(e.created_at)}</span>
    </li>
  );
}

export default function History() {
  const [status, setStatus] = useState('');
  const ev = useApi(`/events?limit=300${status ? `&status=${status}` : ''}`, { refreshMs: 20000 });
  return (
    <>
      <PageHead title="Automation history" sub="Every automated step and every error, newest first." />
      <div className="mb-4 flex gap-1">
        {[['', 'All'], ['error', 'Errors'], ['skipped', 'Skipped']].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k)} className={`rounded-md px-3 py-1.5 text-sm ${status === k ? 'bg-ink text-white' : 'bg-white border border-line'}`}>{l}</button>
        ))}
      </div>
      <ErrorNote error={ev.error} />
      {ev.data && !ev.data.length && <Empty title={status === 'error' ? 'No errors' : 'Nothing yet'} />}
      {ev.data?.length > 0 && <ul className="rounded-lg border border-line bg-white divide-y divide-line">{ev.data.map((e) => <EventRow key={e.id} e={e} showLead />)}</ul>}
    </>
  );
}
