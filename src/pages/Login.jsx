import { useEffect, useState } from 'react';
import { api, useSession } from '../session.jsx';
import { Button, ErrorNote, Field, inputCls, useAction } from '../ui.jsx';

function DemoLogin({ signInDemo }) {
  const [users, setUsers] = useState([]);
  useEffect(() => { api('/demo/users').then(setUsers); }, []);
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate">Pick a sample account. Bright Path and Summit are separate businesses — sign in as each to see that neither can see the other's leads.</p>
      {users.map((u) => (
        <button key={u.id} onClick={() => signInDemo(u.id)} className="w-full text-left rounded-md border border-line bg-white px-4 py-3 hover:border-ink">
          <span className="font-medium">{u.name}</span><span className="block text-xs text-slate">{u.email}</span>
        </button>
      ))}
    </div>
  );
}

function PasswordLogin({ supabase }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const fn = mode === 'signin' ? supabase.auth.signInWithPassword : supabase.auth.signUp;
      const { data, error: err } = await fn.call(supabase.auth, { email, password });
      if (err) throw err;
      if (mode === 'signup' && !data.session) setNote('Check your email to confirm your account, then sign in.');
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email"><input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
      <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
        <input className={inputCls} type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
      </Field>
      <ErrorNote error={error} />
      {note && <p className="text-sm text-done">{note}</p>}
      <Button type="submit" disabled={busy} className="w-full">{mode === 'signin' ? 'Sign in' : 'Create account'}</Button>
      <button type="button" className="text-sm text-slate underline underline-offset-2" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
        {mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </button>
    </form>
  );
}

function CreateWorkspace({ reload }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/workspaces', { method: 'POST', body: { name, slug } }); await reload(); }); }}>
      <p className="text-sm text-slate">Set up your tutoring center. You'll be the owner and can invite staff afterwards.</p>
      <p className="text-sm text-slate">Joining a center that already uses Luminary? Ask the owner to invite this exact email address, then sign out and sign in again.</p>
      <Field label="Center name"><input className={inputCls} required value={name} onChange={(e) => { setName(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)); }} /></Field>
      <Field label="Inquiry form address" hint={`Families will use ${location.origin}/f/${slug || 'your-center'}`}>
        <input className={inputCls} required pattern="[a-z0-9-]{3,48}" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" disabled={busy} className="w-full">Create workspace</Button>
    </form>
  );
}

export default function Login() {
  const { status, me, supabase, signInDemo, reload, signOut } = useSession();
  return (
    <div className="min-h-screen grid md:grid-cols-2">
      <section className="bg-ink text-white px-8 py-12 md:py-20 flex flex-col justify-between">
        <div>
          <p className="font-display text-2xl font-bold">Luminary Automation</p>
          <h1 className="mt-10 text-4xl md:text-5xl font-bold leading-[1.05] max-w-md">Every family who asks about tutoring hears back today.</h1>
          <p className="mt-5 max-w-sm text-white/75">Inquiries land in one place. A reply is drafted from your own services, prices and hours. You approve it, and follow-ups are scheduled for you.</p>
        </div>
        <div className="mt-10 h-[3px] w-40 bg-pencil" aria-hidden="true" />
      </section>
      <section className="px-6 sm:px-12 py-12 md:py-20 max-w-md w-full mx-auto self-center">
        <h2 className="text-2xl font-bold mb-5">{me ? 'Create your workspace' : 'Sign in'}</h2>
        {me ? (
          <>
            <CreateWorkspace reload={reload} />
            <button className="mt-4 text-sm text-slate underline" onClick={signOut}>Sign out</button>
          </>
        ) : status.demo ? <DemoLogin signInDemo={signInDemo} /> : <PasswordLogin supabase={supabase} />}
      </section>
    </div>
  );
}
