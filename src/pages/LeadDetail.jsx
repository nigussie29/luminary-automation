import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi } from '../session.jsx';
import { Button, ErrorNote, Field, StageRail, fmtDate, inputCls, useAction } from '../ui.jsx';
import MessageReview from './MessageReview.jsx';
import { EventRow } from './History.jsx';

const REMINDER = {
  staff_respond_overdue: 'Alert staff if no reply', follow_up_1: 'Follow-up #1', follow_up_2: 'Follow-up #2 (final)',
  appointment_reminder: 'Appointment reminder', post_appointment: 'After-appointment check-in',
};
const APPT = { consultation: 'Consultation', assessment: 'Assessment', trial_session: 'Trial session' };

function Classification({ lead, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ subject: lead.subject || '', grade_level: lead.grade_level || '', service: lead.service || '' });
  const { busy, error, run } = useAction();
  const method = lead.analysis?.method;
  if (!edit) {
    return (
      <div className="text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-slate">Subject</dt><dd>{lead.subject || <em className="text-slate">Unknown</em>}</dd>
          <dt className="text-slate">Grade</dt><dd>{lead.grade_level || <em className="text-slate">Unknown</em>}</dd>
          <dt className="text-slate">Service</dt><dd>{lead.service || <em className="text-slate">Not matched</em>}</dd>
          {lead.analysis?.urgency === 'high' && <><dt className="text-slate">Urgency</dt><dd className="font-medium">High</dd></>}
        </dl>
        <p className="mt-2 text-xs text-slate">
          {method === 'ai' ? 'Identified by AI.' : method === 'simulated' ? 'Identified by simulated AI (demo rules).' : method === 'rules' ? 'Identified by fallback rules because AI was unavailable.' : 'Not analysed yet.'}{' '}
          <button className="underline" onClick={() => setEdit(true)}>Correct</button>
        </p>
      </div>
    );
  }
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/leads/${lead.id}`, { method: 'PATCH', body: f }); setEdit(false); onSaved(); }); }}>
      {[['subject', 'Subject'], ['grade_level', 'Grade'], ['service', 'Service']].map(([k, l]) => (
        <Field key={k} label={l}><input className={inputCls} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
      ))}
      <ErrorNote error={error} />
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Save</Button><Button type="button" variant="quiet" onClick={() => setEdit(false)}>Cancel</Button></div>
    </form>
  );
}

function BookForm({ leadId, onDone }) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState('');
  const [kind, setKind] = useState('consultation');
  const [notes, setNotes] = useState('');
  const { busy, error, run } = useAction();
  if (!open) return <Button onClick={() => setOpen(true)}>Book appointment</Button>;
  return (
    <form className="space-y-3 rounded-lg border border-line bg-white p-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/leads/${leadId}/appointments`, { method: 'POST', body: { starts_at: new Date(when).toISOString(), kind, notes } }); setOpen(false); onDone(); }); }}>
      <Field label="Date and time"><input type="datetime-local" required className={inputCls} value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <Field label="Type"><select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(APPT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Notes (internal)"><input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <p className="text-xs text-slate">Booking moves the lead to Appointment Booked, stops follow-ups, and schedules a reminder 24 hours before.</p>
      <ErrorNote error={error} />
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Book</Button><Button type="button" variant="quiet" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}

function ComposeForm({ leadId, onDone }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const { busy, error, run } = useAction();
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Write a message</Button>;
  return (
    <form className="space-y-2 rounded-lg border border-line bg-white p-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/leads/${leadId}/messages`, { method: 'POST', body: { subject, body } }); setOpen(false); setBody(''); onDone(); }); }}>
      <input className={inputCls} placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
      <textarea className={`${inputCls} min-h-32`} required value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
      <ErrorNote error={error} />
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Add to review queue</Button><Button type="button" variant="quiet" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}

export default function LeadDetail() {
  const { id } = useParams();
  const r = useApi(`/leads/${id}`);
  const act = useAction();
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="text-slate">Loading…</p>;
  const { lead, messages, appointments, reminders, events } = r.data;
  const pending = messages.filter((m) => ['pending_review', 'failed'].includes(m.status));
  const sent = messages.filter((m) => m.status === 'sent');
  const open = ['new', 'contacted', 'appointment_booked'].includes(lead.stage);
  const stage = (to, reason) => act.run(async () => { await api(`/leads/${id}/stage`, { method: 'POST', body: { stage: to, reason } }); r.reload(); });
  const apptStatus = (aid, status) => act.run(async () => { await api(`/appointments/${aid}`, { method: 'PATCH', body: { status } }); r.reload(); });

  return (
    <>
      <Link to="/leads" className="text-sm text-slate hover:text-ink">Back to leads</Link>
      <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{lead.parent_name || lead.email || lead.phone}</h1>
          <p className="text-slate text-sm">{[lead.student_name && `Student: ${lead.student_name}`, lead.email, lead.phone].filter(Boolean).join(', ')}</p>
          <p className="text-slate text-xs mt-1">Received {fmtDate(lead.created_at)}{lead.first_response_at && `, first reply ${fmtDate(lead.first_response_at)}`}</p>
        </div>
        <StageRail stage={lead.stage} />
      </div>
      <ErrorNote error={act.error} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-8 min-w-0">
          {pending.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-lg font-bold">Waiting for review</h2>
              {pending.map((m) => <MessageReview key={m.id} msg={m} to={lead.email} onDone={r.reload} />)}
            </section>
          )}
          <section>
            <h2 className="text-lg font-bold mb-2">Inquiry</h2>
            <p className="whitespace-pre-line rounded-lg border border-line bg-white p-4 text-sm leading-relaxed max-w-prose">{lead.message}</p>
          </section>
          {open && (
            <section className="flex flex-wrap gap-2 items-start">
              <BookForm leadId={id} onDone={r.reload} />
              <ComposeForm leadId={id} onDone={r.reload} />
              <Button variant="secondary" disabled={act.busy} onClick={() => act.run(async () => { await api(`/leads/${id}/draft`, { method: 'POST' }); r.reload(); })}>New AI draft</Button>
              {lead.stage === 'new' && <Button variant="secondary" onClick={() => stage('contacted', 'Contacted outside the app')}>Mark contacted</Button>}
              {lead.stage !== 'new' && <Button variant="secondary" onClick={() => stage('enrolled')}>Mark enrolled</Button>}
              <Button variant="danger" onClick={() => { const why = prompt('Why are you closing this lead? (optional)'); if (why !== null) stage('closed', why); }}>Close lead</Button>
            </section>
          )}
          {lead.stage === 'closed' && <Button variant="secondary" onClick={() => stage('new', 'Reopened')}>Reopen lead</Button>}
          {sent.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-2">Sent</h2>
              <ul className="space-y-2">
                {sent.map((m) => (
                  <li key={m.id}>
                    <details className="rounded-lg border border-line bg-white px-4 py-3 text-sm">
                      <summary className="cursor-pointer"><strong>{m.subject}</strong> <span className="text-slate">{fmtDate(m.sent_at)}{m.delivery_mode === 'simulated' && ', simulated (not actually delivered)'}</span></summary>
                      <p className="mt-2 whitespace-pre-line text-slate">{m.body}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2 className="text-lg font-bold mb-2">History</h2>
            <ul className="rounded-lg border border-line bg-white divide-y divide-line">{events.map((e) => <EventRow key={e.id} e={e} />)}</ul>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="rounded-lg border border-line bg-white p-4">
            <h2 className="font-bold mb-2">What they need</h2>
            <Classification lead={lead} onSaved={r.reload} />
          </section>
          <section className="rounded-lg border border-line bg-white p-4">
            <h2 className="font-bold mb-2">Appointments</h2>
            {!appointments.length && <p className="text-sm text-slate">None booked.</p>}
            <ul className="space-y-3 text-sm">
              {appointments.map((a) => (
                <li key={a.id}>
                  <p><strong>{APPT[a.kind]}</strong>, {fmtDate(a.starts_at, { weekday: 'short' })}</p>
                  <p className="text-slate capitalize">{a.status.replace('_', '-')}{a.notes && `: ${a.notes}`}</p>
                  {a.status === 'scheduled' && (
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
                      <button className="underline" onClick={() => apptStatus(a.id, 'completed')}>Attended</button>
                      <button className="underline" onClick={() => apptStatus(a.id, 'no_show')}>No-show</button>
                      <button className="underline text-brick" onClick={() => apptStatus(a.id, 'cancelled')}>Cancel</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-lg border border-line bg-white p-4">
            <h2 className="font-bold mb-2">Scheduled automation</h2>
            {!reminders.length && <p className="text-sm text-slate">Nothing scheduled.</p>}
            <ol className="space-y-2 text-sm">
              {reminders.map((m) => (
                <li key={m.id} className={m.status === 'pending' ? '' : 'text-slate'}>
                  <span className={m.status === 'pending' ? 'font-medium' : m.status === 'cancelled' || m.status === 'skipped' ? 'line-through' : ''}>{REMINDER[m.kind]}</span>
                  <span className="block text-xs">{m.status === 'pending' ? `Due ${fmtDate(m.due_at)}` : `${m.status}${m.result ? `: ${m.result}` : ''}`}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}
