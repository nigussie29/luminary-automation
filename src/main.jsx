import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { SessionProvider, useSession, api } from './session.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Leads from './pages/Leads.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import Queue from './pages/Queue.jsx';
import Appointments from './pages/Appointments.jsx';
import History from './pages/History.jsx';
import Settings from './pages/Settings.jsx';
import PublicForm from './pages/PublicForm.jsx';

const MODE_TEXT = {
  live: 'Live', simulated: 'Simulated', demo: 'Demo accounts', 'in-memory': 'Sample data (resets on restart)',
  'local-file': 'Local file', internal: 'Tracked in app',
};

function IntegrationStrip({ status }) {
  if (!status) return null;
  const i = status.integrations;
  const rows = [['Sign-in', i.auth], ['Database', i.database], ['AI', i.ai], ['Email', i.email], ['Calendar', i.calendar]];
  const anySim = rows.some(([, v]) => v !== 'live' && v !== 'internal');
  return (
    <div className={`text-xs px-4 sm:px-8 py-2 flex flex-wrap gap-x-5 gap-y-1 border-b ${anySim ? 'bg-pencil-soft border-pencil/40' : 'bg-white border-line'}`}>
      {status.demo && <strong className="font-semibold">Demo mode — nothing here reaches a real family.</strong>}
      {rows.map(([k, v]) => (
        <span key={k}>{k}: <span className={v === 'live' ? 'text-done font-medium' : 'font-medium'}>{MODE_TEXT[v] || v}</span></span>
      ))}
    </div>
  );
}

function Shell({ children }) {
  const { status, me, workspace, selectWorkspace, signOut } = useSession();
  const [queueCount, setQueueCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => api('/queue').then((q) => alive && setQueueCount(q.filter((m) => m.status === 'pending_review').length)).catch(() => {});
    tick();
    const t = setInterval(tick, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [workspace?.id]);
  const link = ({ isActive }) => `flex items-center justify-between rounded-md px-3 py-2 text-sm ${isActive ? 'bg-ink text-white' : 'text-ink hover:bg-line/50'}`;
  return (
    <div className="min-h-screen">
      <IntegrationStrip status={status} />
      <div className="flex flex-col md:flex-row">
        <aside className="md:w-60 md:min-h-[calc(100vh-34px)] border-b md:border-b-0 md:border-r border-line bg-white px-4 py-5">
          <p className="font-display text-xl font-bold leading-tight">Luminary<br /><span className="font-medium text-slate">Automation</span></p>
          {me.workspaces.length > 1 ? (
            <select aria-label="Workspace" className="mt-4 w-full rounded-md border border-line px-2 py-1.5 text-sm" value={workspace.id} onChange={(e) => { selectWorkspace(e.target.value); location.assign('/'); }}>
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          ) : <p className="mt-4 text-sm font-medium">{workspace.name}</p>}
          <p className="text-xs text-slate">{workspace.role === 'owner' ? 'Owner' : 'Staff'}<br />{me.user.email}</p>
          <nav className="mt-5 grid grid-cols-2 md:grid-cols-1 gap-1">
            <NavLink to="/" end className={link}>Today</NavLink>
            <NavLink to="/queue" className={link}>
              Review queue
              {queueCount > 0 && <span className="rounded-full bg-pencil text-ink text-xs font-semibold px-2">{queueCount}</span>}
            </NavLink>
            <NavLink to="/leads" className={link}>Leads</NavLink>
            <NavLink to="/appointments" className={link}>Appointments</NavLink>
            <NavLink to="/history" className={link}>Automation history</NavLink>
            <NavLink to="/settings" className={link}>Settings</NavLink>
          </nav>
          <div className="mt-6 text-xs text-slate space-y-1">
            <a className="block hover:text-ink underline underline-offset-2" href={`/f/${workspace.slug}`} target="_blank" rel="noreferrer">Open inquiry form</a>
            <button className="hover:text-ink underline underline-offset-2" onClick={signOut}>Sign out</button>
          </div>
        </aside>
        <main className="flex-1 min-w-0 px-4 sm:px-8 py-6 max-w-6xl">{children}</main>
      </div>
    </div>
  );
}

function App() {
  const { me, workspace, status } = useSession();
  return (
    <Routes>
      <Route path="/f/:slug" element={<PublicForm />} />
      <Route path="*" element={
        !status || me === undefined ? <p className="p-8 text-slate">Loading…</p>
          : !me || !workspace ? <Login />
            : (
              <Shell>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/queue" element={<Queue />} />
                  <Route path="/leads" element={<Leads />} />
                  <Route path="/leads/:id" element={<LeadDetail />} />
                  <Route path="/appointments" element={<Appointments />} />
                  <Route path="/history" element={<History />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/" />} />
                </Routes>
              </Shell>
            )
      } />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider><App /></SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
