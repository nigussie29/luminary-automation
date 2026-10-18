import { Link } from 'react-router-dom';
import { api, useApi } from '../session.jsx';
import { Empty, ErrorNote, PageHead, useAction } from '../ui.jsx';

const KIND = { consultation: 'Consultation', assessment: 'Assessment', trial_session: 'Trial session' };

export default function Appointments() {
  const a = useApi('/appointments');
  const act = useAction();
  const set = (id, status) => act.run(async () => { await api(`/appointments/${id}`, { method: 'PATCH', body: { status } }); a.reload(); });
  const byDay = {};
  for (const x of a.data || []) {
    const day = new Date(x.starts_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    (byDay[day] ||= []).push(x);
  }
  return (
    <>
      <PageHead title="Appointments" sub="Consultations, assessments and trial sessions. Book them from a lead." />
      <ErrorNote error={a.error || act.error} />
      {a.data && !a.data.length && <Empty title="No upcoming appointments">Open a lead and choose Book appointment.</Empty>}
      <div className="space-y-6">
        {Object.entries(byDay).map(([day, items]) => (
          <section key={day}>
            <h2 className="font-bold mb-2">{day}</h2>
            <ul className="rounded-lg border border-line bg-white divide-y divide-line">
              {items.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span className="w-20 font-medium">{new Date(x.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                  <span className="flex-1 min-w-40"><Link to={`/leads/${x.lead_id}`} className="font-medium hover:underline">{x.parent_name}</Link>
                    <span className="block text-xs text-slate">{KIND[x.kind]}{x.subject ? `, ${x.subject}` : ''}{x.grade_level ? `, ${x.grade_level}` : ''}</span></span>
                  {x.status === 'scheduled' ? (
                    <span className="flex gap-3 text-xs">
                      <button className="underline" onClick={() => set(x.id, 'completed')}>Attended</button>
                      <button className="underline" onClick={() => set(x.id, 'no_show')}>No-show</button>
                      <button className="underline text-brick" onClick={() => set(x.id, 'cancelled')}>Cancel</button>
                    </span>
                  ) : <span className="text-xs text-slate capitalize">{x.status.replace('_', '-')}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-6 text-xs text-slate">Appointments are tracked here. Calendar sync (Google/Outlook) is not connected in this version.</p>
    </>
  );
}
