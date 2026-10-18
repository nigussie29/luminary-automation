// The page families see. No login. Can also be embedded in a center's site with an <iframe>.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../session.jsx';
import { Button, ErrorNote, Field, inputCls, useAction } from '../ui.jsx';

export default function PublicForm() {
  const { slug } = useParams();
  const [center, setCenter] = useState(undefined);
  const [f, setF] = useState({ parent_name: '', student_name: '', email: '', phone: '', message: '', website: '' });
  const [done, setDone] = useState(null);
  const { busy, error, run } = useAction();
  useEffect(() => { api(`/public/forms/${slug}`).then(setCenter).catch(() => setCenter(null)); }, [slug]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  if (center === undefined) return null;
  if (center === null) return <p className="p-8">This inquiry form doesn't exist. Check the link with the tutoring center.</p>;
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-xl px-5 py-10 sm:py-16">
        <p className="text-sm text-slate">{center.name}</p>
        <h1 className="mt-1 text-3xl font-bold">Ask about tutoring</h1>
        <div className="mt-3 mb-8 h-[3px] w-24 bg-pencil" aria-hidden="true" />
        {done ? (
          <p className="text-lg" role="status">{done}</p>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api(`/public/forms/${slug}/inquiries`, { method: 'POST', body: f }); setDone(r.message); }); }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name"><input className={inputCls} required value={f.parent_name} onChange={set('parent_name')} autoComplete="name" /></Field>
              <Field label="Student's name (optional)"><input className={inputCls} value={f.student_name} onChange={set('student_name')} /></Field>
              <Field label="Email"><input className={inputCls} type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
              <Field label="Phone (optional)"><input className={inputCls} type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></Field>
            </div>
            <Field label="How can we help?" hint="Subject, grade, and anything coming up, like a test date.">
              <textarea className={`${inputCls} min-h-32`} required minLength={5} value={f.message} onChange={set('message')} />
            </Field>
            {/* Honeypot: hidden from people, filled by bots. */}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} className="absolute -left-[9999px]" aria-hidden="true" />
            <ErrorNote error={error} />
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">Send inquiry</Button>
            <p className="text-xs text-slate">We'll use your details only to reply about tutoring.</p>
          </form>
        )}
      </div>
    </div>
  );
}
