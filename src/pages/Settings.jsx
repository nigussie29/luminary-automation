import { useEffect, useState } from 'react';
import { api, useApi, useSession } from '../session.jsx';
import { Button, ErrorNote, Field, PageHead, inputCls, useAction } from '../ui.jsx';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const hourLabel = (h) => (h === 24 ? 'Midnight' : new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' }));

const KINDS = [['service', 'Services'], ['price', 'Prices'], ['hours', 'Hours'], ['faq', 'FAQs'], ['policy', 'Policies']];

function KnowledgeItem({ item, owner, onChange }) {
  const [edit, setEdit] = useState(!item.id);
  const [f, setF] = useState(item);
  const { busy, error, run } = useAction();
  if (!edit) {
    return (
      <li className="px-4 py-3 text-sm">
        <div className="flex justify-between gap-3"><strong>{item.title}</strong>{owner && <button className="text-xs underline text-slate" onClick={() => setEdit(true)}>Edit</button>}</div>
        <p className="text-slate">{item.content}</p>
      </li>
    );
  }
  return (
    <li className="px-4 py-3">
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(item.id ? `/knowledge/${item.id}` : '/knowledge', { method: item.id ? 'PUT' : 'POST', body: f }); setEdit(false); onChange(); }); }}>
        <input className={inputCls} placeholder="Title, e.g. SAT/ACT Prep" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Title" />
        <textarea className={`${inputCls} min-h-20`} placeholder="Exactly what the AI may tell families" required value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} aria-label="Content" />
        <ErrorNote error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button type="button" variant="quiet" onClick={() => (item.id ? setEdit(false) : onChange())}>Cancel</Button>
          {item.id && <Button type="button" variant="danger" className="ml-auto" onClick={() => run(async () => { await api(`/knowledge/${item.id}`, { method: 'DELETE' }); onChange(); })}>Delete</Button>}
        </div>
      </form>
    </li>
  );
}

function Knowledge({ owner }) {
  const kb = useApi('/knowledge');
  const [adding, setAdding] = useState(null);
  const reload = () => { setAdding(null); kb.reload(); };
  return (
    <section>
      <h2 className="text-xl font-bold">Knowledge base</h2>
      <p className="text-sm text-slate mb-4 max-w-prose">The AI may only state what's written here. If a family asks about something missing, the draft leaves it out and lists it for you instead of guessing. Write prices exactly as you'd quote them.</p>
      <ErrorNote error={kb.error} />
      <div className="grid gap-5 lg:grid-cols-2">
        {KINDS.map(([k, label]) => (
          <div key={k}>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="font-bold">{label}</h3>
              {owner && <button className="text-sm underline" onClick={() => setAdding(k)}>Add</button>}
            </div>
            <ul className="rounded-lg border border-line bg-white divide-y divide-line">
              {kb.data?.filter((i) => i.kind === k).map((i) => <KnowledgeItem key={i.id} item={i} owner={owner} onChange={reload} />)}
              {adding === k && <KnowledgeItem item={{ kind: k, title: '', content: '' }} owner onChange={reload} />}
              {kb.data && !kb.data.some((i) => i.kind === k) && adding !== k && <li className="px-4 py-3 text-sm text-slate">None yet.</li>}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Center({ owner }) {
  const ws = useApi('/workspace');
  const [f, setF] = useState(null);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (ws.data) setF(ws.data); }, [ws.data]);
  if (!f) return null;
  const input = (k, props = {}) => <input className={inputCls} disabled={!owner} value={f[k] || ''} onChange={(e) => { setSaved(false); setF({ ...f, [k]: e.target.value }); }} {...props} />;
  return (
    <section>
      <h2 className="text-xl font-bold mb-4">Center details</h2>
      <form className="grid gap-4 sm:grid-cols-2 max-w-3xl" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/workspace', { method: 'PATCH', body: { name: f.name, timezone: f.timezone, reply_from: f.reply_from, reply_to: f.reply_to, booking_link: f.booking_link || null, open_days: f.open_days, open_hour: Number(f.open_hour), close_hour: Number(f.close_hour) } }); setSaved(true); }); }}>
        <Field label="Center name">{input('name', { required: true })}</Field>
        <Field label="Time zone" hint="Used for appointment reminders.">{input('timezone')}</Field>
        <Field label="Sign emails as" hint="e.g. Maya at Bright Path Tutoring">{input('reply_from')}</Field>
        <Field label="Replies go to" hint="Your inbox. Families' replies arrive here.">{input('reply_to', { type: 'email' })}</Field>
        <Field label="Booking link (optional)" hint="Calendly, Acuity, etc. Added to replies when set.">{input('booking_link', { type: 'url', placeholder: 'https://' })}</Field>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium mb-1">Business hours</legend>
          <div className="flex flex-wrap items-center gap-2">
            {DAYS.map(([d, l]) => {
              const on = f.open_days?.map(Number).includes(d);
              return (
                <button key={d} type="button" disabled={!owner} aria-pressed={on}
                  onClick={() => { setSaved(false); setF({ ...f, open_days: on ? f.open_days.filter((x) => Number(x) !== d) : [...(f.open_days || []), d] }); }}
                  className={`rounded-md px-2.5 py-1.5 text-sm ${on ? 'bg-ink text-white' : 'bg-white border border-line text-slate'}`}>{l}</button>
              );
            })}
            <select aria-label="Opens" disabled={!owner} className="rounded-md border border-line bg-white px-2 py-1.5 text-sm" value={f.open_hour} onChange={(e) => { setSaved(false); setF({ ...f, open_hour: Number(e.target.value) }); }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
            <span className="text-sm">to</span>
            <select aria-label="Closes" disabled={!owner} className="rounded-md border border-line bg-white px-2 py-1.5 text-sm" value={f.close_hour} onChange={(e) => { setSaved(false); setF({ ...f, close_hour: Number(e.target.value) }); }}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
          <span className="block text-xs text-slate mt-1">The "no reply after 2 hours" alert only counts these hours. An inquiry on Saturday night is flagged two open hours into Monday.</span>
        </fieldset>
        <Field label="Inquiry form"><a className="block py-2 text-sm underline break-all" href={`/f/${f.slug}`} target="_blank" rel="noreferrer">{location.origin}/f/{f.slug}</a></Field>
        {owner && <div className="sm:col-span-2 flex items-center gap-3"><Button type="submit" disabled={busy}>Save changes</Button>{saved && <span className="text-sm text-done">Saved</span>}<ErrorNote error={error} /></div>}
      </form>
    </section>
  );
}

function Team() {
  const m = useApi('/members');
  const [email, setEmail] = useState('');
  const { busy, error, run } = useAction();
  const { status } = useSession();
  return (
    <section>
      <h2 className="text-xl font-bold mb-1">Team</h2>
      <p className="text-sm text-slate mb-3">Staff can review and send messages, and manage leads and appointments. Only owners can change prices, settings and the team.</p>
      <ErrorNote error={m.error} />
      <ul className="rounded-lg border border-line bg-white divide-y divide-line max-w-xl">
        {m.data?.map((u) => (
          <li key={u.email} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span>{u.email} <span className="text-slate">({u.role}{u.pending ? ', invited — joins when they sign in' : ''})</span></span>
            {u.pending
              ? <button className="text-xs underline text-brick" onClick={() => run(async () => { await api(`/invites/${encodeURIComponent(u.email)}`, { method: 'DELETE' }); m.reload(); })}>Cancel invite</button>
              : u.role !== 'owner' && <button className="text-xs underline text-brick" onClick={() => run(async () => { await api(`/members/${u.user_id}`, { method: 'DELETE' }); m.reload(); })}>Remove</button>}
          </li>
        ))}
      </ul>
      <form className="mt-3 flex gap-2 max-w-xl" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/members', { method: 'POST', body: { email, role: 'staff' } }); setEmail(''); m.reload(); }); }}>
        <input className={inputCls} type="email" required placeholder="staff@yourcenter.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Staff email" />
        <Button type="submit" disabled={busy} className="whitespace-nowrap">Invite staff</Button>
      </form>
      <p className="mt-1 text-xs text-slate">{status.demo ? 'Demo mode: invites are recorded, but sample accounts can\'t accept them.' : `Send them ${location.origin}. They create an account with this email, confirm it, and join automatically.`}</p>
      <ErrorNote error={error} />
    </section>
  );
}

export default function Settings() {
  const { workspace } = useSession();
  const owner = workspace.role === 'owner';
  return (
    <>
      <PageHead title="Settings" sub={owner ? undefined : 'You can view these settings. Ask an owner to change them.'} />
      <div className="space-y-12">
        <Knowledge owner={owner} />
        <Center owner={owner} />
        {owner && <Team />}
      </div>
    </>
  );
}
