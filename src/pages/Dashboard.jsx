import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, useApi, useSession } from '../session.jsx';
import { Button, ErrorNote, PageHead, StageTag, ago, minutes } from '../ui.jsx';

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function Funnel({ d }) {
  const steps = [
    ['Inquiries', d.inquiries, null],
    ['Replied', d.responded, d.inquiries ? d.responded / d.inquiries : null],
    ['Booked', d.booked, d.booking_rate],
    ['Enrolled', d.enrolled, d.enrollment_rate],
  ];
  const max = Math.max(d.inquiries, 1);
  return (
    <section className="rounded-lg border border-line bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Last {d.window_days} days</h2>
        <p className="text-sm text-slate">Median first reply: <strong className="text-ink">{minutes(d.median_response_minutes)}</strong></p>
      </div>
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
        {steps.map(([label, n, rate]) => (
          <div key={label}>
            <p className="text-sm text-slate">{label}</p>
            <p className="font-display text-3xl font-bold">{n}</p>
            <div className="mt-2 h-[3px] bg-line"><div className="h-[3px] bg-pencil" style={{ width: `${(n / max) * 100}%` }} /></div>
            <p className="mt-1 text-xs text-slate">{rate == null ? ' ' : `${pct(rate)} of inquiries`}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const { status, workspace } = useSession();
  const dash = useApi('/dashboard');
  const fresh = useApi('/leads?stage=new&limit=8');
  const [ran, setRan] = useState(null);
  if (dash.error) return <ErrorNote error={dash.error} />;
  if (!dash.data) return <p className="text-slate">Loading…</p>;
  const d = dash.data;
  const u = d.ai_usage;
  const needs = [
    d.pending_review && { to: '/queue', text: `${d.pending_review} message${d.pending_review > 1 ? 's' : ''} waiting for your review` },
    d.overdue && { to: '/leads?stage=new', text: `${d.overdue} new inquir${d.overdue > 1 ? 'ies have' : 'y has'} had no reply after 2 open hours` },
    d.failed_messages && { to: '/queue', text: `${d.failed_messages} message${d.failed_messages > 1 ? 's' : ''} failed to send` },
    d.errors_7d && { to: '/history', text: `${d.errors_7d} automation error${d.errors_7d > 1 ? 's' : ''} this week` },
  ].filter(Boolean);

  return (
    <>
      <PageHead title="Today" sub={workspace.name}>
        {status.demo && (
          <Button variant="secondary" onClick={async () => { const r = await api('/demo/run-reminders', { method: 'POST' }); setRan(r.processed); dash.reload(); fresh.reload(); }}>
            Run due reminders now
          </Button>
        )}
      </PageHead>
      {ran != null && <p className="mb-4 text-sm text-slate">Reminder engine ran: {ran} reminder{ran === 1 ? '' : 's'} processed.</p>}

      <section className="mb-6">
        <h2 className="text-lg font-bold mb-2">Needs you</h2>
        {needs.length ? (
          <ul className="space-y-2">
            {needs.map((n) => (
              <li key={n.text}><Link to={n.to} className="block rounded-md border-l-4 border-pencil bg-pencil-soft px-4 py-3 hover:bg-pencil/30">{n.text}</Link></li>
            ))}
          </ul>
        ) : <p className="text-slate">You're caught up. New inquiries will appear here.</p>}
      </section>

      <Funnel d={d} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section>
          <h2 className="text-lg font-bold mb-2">Newest inquiries</h2>
          {fresh.data?.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line bg-white">
              {fresh.data.map((l) => (
                <li key={l.id}>
                  <Link to={`/leads/${l.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-paper">
                    <span>
                      <span className="font-medium">{l.parent_name || l.email || l.phone}</span>
                      <span className="block text-sm text-slate">{[l.subject, l.grade_level, l.service].filter(Boolean).join(', ') || 'Not yet classified'}</span>
                    </span>
                    <span className="text-right text-xs text-slate shrink-0"><StageTag stage={l.stage} /><span className="block mt-1">{ago(l.created_at)}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="text-slate">No new inquiries. Share your form link so families can reach you.</p>}
        </section>
        <section className="rounded-lg border border-line bg-white p-5 self-start">
          <h2 className="text-lg font-bold">AI usage this month</h2>
          <p className="mt-2 font-display text-3xl font-bold">{u.ops}<span className="text-base font-normal text-slate"> / {u.limit} actions</span></p>
          <div className="mt-2 h-[3px] bg-line"><div className={`h-[3px] ${u.ops / u.limit > 0.9 ? 'bg-brick' : 'bg-ink'}`} style={{ width: `${Math.min(100, (u.ops / u.limit) * 100)}%` }} /></div>
          <dl className="mt-3 text-sm grid grid-cols-2 gap-y-1">
            <dt className="text-slate">Plan</dt><dd>{u.plan_label}</dd>
            <dt className="text-slate">Tokens</dt><dd>{(u.input_tokens + u.output_tokens).toLocaleString()}</dd>
            <dt className="text-slate">Est. AI cost</dt><dd>${u.cost_usd.toFixed(4)}</dd>
            {u.simulated_ops > 0 && <><dt className="text-slate">Simulated</dt><dd>{u.simulated_ops} actions</dd></>}
          </dl>
          <p className="mt-3 text-xs text-slate">One inquiry uses about two actions: reading it and drafting the reply. Past the limit, replies use a fixed template.</p>
          <p className="mt-3 text-sm">Upcoming appointments: <strong>{d.upcoming_appointments}</strong></p>
        </section>
      </div>
    </>
  );
}
