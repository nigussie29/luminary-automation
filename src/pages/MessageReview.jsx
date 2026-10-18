import { useState } from 'react';
import { api } from '../session.jsx';
import { Button, ErrorNote, Flags, inputCls, useAction } from '../ui.jsx';

const SOURCE = { ai: 'Drafted by AI', ai_simulated: 'Drafted by simulated AI (demo)', template: 'Rules-based template', staff: 'Written by staff' };
const PURPOSE = { first_response: 'First reply', follow_up: 'Follow-up', appointment_reminder: 'Appointment reminder', post_appointment: 'After appointment', manual: 'Message' };

/** One outgoing message under review: edit, approve & send, or discard. */
export default function MessageReview({ msg, to, onDone }) {
  const [subject, setSubject] = useState(msg.subject);
  const [body, setBody] = useState(msg.body);
  const [flags, setFlags] = useState(msg.flags || []);
  const [ack, setAck] = useState(false);
  const { busy, error, run } = useAction();
  const dirty = subject !== msg.subject || body !== msg.body;
  const blocking = flags.some((f) => f.severity === 'block');

  const save = () => run(async () => { const m = await api(`/messages/${msg.id}`, { method: 'PATCH', body: { subject, body } }); setFlags(m.flags); msg.subject = m.subject; msg.body = m.body; });
  const approve = () => run(async () => {
    if (dirty) { const m = await api(`/messages/${msg.id}`, { method: 'PATCH', body: { subject, body } }); setFlags(m.flags); if (m.flags.some((f) => f.severity === 'block') && !ack) return; }
    const r = await api(`/messages/${msg.id}/approve`, { method: 'POST', body: { acknowledgeFlags: ack } });
    onDone?.(r);
  });
  const reject = () => run(async () => { await api(`/messages/${msg.id}/reject`, { method: 'POST' }); onDone?.(); });

  return (
    <article className="rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm">
        <span><strong>{PURPOSE[msg.purpose]}</strong>{to && <span className="text-slate"> to {to}</span>}</span>
        <span className="text-xs text-slate">{SOURCE[msg.generated_by]}</span>
      </header>
      <div className="p-4 space-y-3">
        {msg.status === 'failed' && <p className="rounded-md bg-brick-soft px-3 py-2 text-sm text-brick">Not sent: {msg.error}. Fix the problem, then send again.</p>}
        <Flags flags={flags} />
        {msg.missing_info?.length > 0 && (
          <div className="rounded-md bg-paper px-3 py-2 text-sm">
            <p className="font-medium">Missing information</p>
            <p className="text-slate text-xs mb-1">The draft leaves these out rather than guessing. Add them to the email yourself, or to your knowledge base in Settings.</p>
            <ul className="list-disc pl-5">{msg.missing_info.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </div>
        )}
        <input aria-label="Subject" className={`${inputCls} font-medium`} value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea aria-label="Message" className={`${inputCls} min-h-56 leading-relaxed`} value={body} onChange={(e) => setBody(e.target.value)} />
        {blocking && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I checked the highlighted details and want to send anyway. This is recorded in the automation history.
          </label>
        )}
        <ErrorNote error={error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={approve} disabled={busy || (blocking && !ack)}>{msg.status === 'failed' ? 'Send again' : 'Approve and send'}</Button>
          {dirty && <Button variant="secondary" onClick={save} disabled={busy}>Save edits</Button>}
          <Button variant="quiet" onClick={reject} disabled={busy}>Discard</Button>
        </div>
      </div>
    </article>
  );
}
