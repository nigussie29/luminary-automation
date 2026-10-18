import { useState } from 'react';

export const STAGES = [
  ['new', 'New'], ['contacted', 'Contacted'], ['appointment_booked', 'Appointment Booked'], ['enrolled', 'Enrolled'], ['closed', 'Closed'],
];
export const stageLabel = (s) => STAGES.find(([k]) => k === s)?.[1] || s;

export function fmtDate(d, opts = {}) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts });
}
export function ago(d) {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}
export function minutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} days`;
}

export function Button({ variant = 'primary', className = '', ...p }) {
  const styles = {
    primary: 'bg-ink text-white hover:bg-ink/90',
    secondary: 'bg-white text-ink border border-line hover:border-slate',
    quiet: 'text-slate hover:text-ink underline-offset-4 hover:underline',
    danger: 'bg-white text-brick border border-brick/40 hover:border-brick',
  };
  return <button {...p} className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant]} ${className}`} />;
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate mt-1">{hint}</span>}
    </label>
  );
}
export const inputCls = 'w-full rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-ink focus:outline-none';

/** The stage rail: a pencil line that fills as a lead moves toward enrollment. */
export function StageRail({ stage }) {
  const order = ['new', 'contacted', 'appointment_booked', 'enrolled'];
  const idx = order.indexOf(stage);
  if (stage === 'closed') return <span className="text-sm text-slate">Closed</span>;
  return (
    <ol className="flex items-center gap-0 text-xs" aria-label={`Stage: ${stageLabel(stage)}`}>
      {order.map((s, i) => (
        <li key={s} className="flex items-center">
          {i > 0 && <span className={`h-[3px] w-6 sm:w-10 ${i <= idx ? 'bg-pencil' : 'bg-line'}`} />}
          <span className={`flex items-center gap-1.5 whitespace-nowrap ${i === idx ? 'font-semibold text-ink' : i < idx ? 'text-ink' : 'text-slate/70'}`}>
            <span className={`h-2.5 w-2.5 rounded-full border-2 ${i <= idx ? 'bg-pencil border-pencil' : 'bg-white border-line'}`} />
            <span className={i === idx ? '' : 'hidden md:inline'}>{stageLabel(s)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StageTag({ stage }) {
  const c = { new: 'bg-pencil-soft text-ink', contacted: 'bg-white text-ink border border-line', appointment_booked: 'bg-ink text-white', enrolled: 'bg-done-soft text-done', closed: 'bg-line/60 text-slate' }[stage];
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${c}`}>{stageLabel(stage)}</span>;
}

export function Flags({ flags }) {
  if (!flags?.length) return null;
  return (
    <ul className="space-y-1.5">
      {flags.map((f, i) => (
        <li key={i} className={`text-sm rounded-md px-3 py-2 ${f.severity === 'block' ? 'bg-pencil-soft border-l-4 border-pencil' : 'bg-paper border-l-4 border-line'}`}>
          {f.message}
        </li>
      ))}
    </ul>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white px-6 py-10 text-center">
      <p className="font-display text-lg">{title}</p>
      {children && <div className="mt-1 text-sm text-slate">{children}</div>}
    </div>
  );
}
export function ErrorNote({ error }) {
  if (!error) return null;
  return <p role="alert" className="rounded-md bg-brick-soft px-3 py-2 text-sm text-brick">{error.message || String(error)}</p>;
}
export function PageHead({ title, children, sub }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold">{title}</h1>
        {sub && <p className="text-slate mt-1">{sub}</p>}
      </div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

/** Runs an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}
