// Session: who is signed in (Supabase in live mode, a sample user in demo mode) and which workspace is active.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);

let supabase = null;
let tokenGetter = async () => null;
let workspaceId = null;

export class ApiError extends Error {
  constructor(status, body) { super(body?.error || `Request failed (${status})`); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = await tokenGetter();
  const res = await fetch(`/api${path}`, {
    method,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function SessionProvider({ children }) {
  const [status, setStatus] = useState(null);       // /api/status
  const [me, setMe] = useState(undefined);          // undefined = loading, null = signed out
  const [wsId, setWsId] = useState(() => localStorage.getItem('la.ws'));

  const loadMe = useCallback(async () => {
    try {
      const m = await api('/me');
      setMe(m);
      const pick = m.workspaces.find((w) => w.id === wsId) || m.workspaces[0];
      workspaceId = pick?.id || null;
      setWsId(workspaceId);
    } catch (e) {
      if (e.status === 401) setMe(null); else throw e;
    }
  }, [wsId]);

  useEffect(() => {
    (async () => {
      const s = await api('/status');
      setStatus(s);
      if (s.demo) {
        tokenGetter = async () => { const id = localStorage.getItem('la.demoUser'); return id ? `demo:${id}` : null; };
      } else {
        const { createClient } = await import('@supabase/supabase-js');
        supabase = createClient(s.supabase.url, s.supabase.anonKey);
        tokenGetter = async () => (await supabase.auth.getSession()).data.session?.access_token || null;
        supabase.auth.onAuthStateChange(() => loadMe());
      }
      await loadMe();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(() => ({
    status, me, supabase,
    workspace: me?.workspaces?.find((w) => w.id === wsId) || null,
    selectWorkspace(id) { workspaceId = id; localStorage.setItem('la.ws', id); setWsId(id); },
    async signInDemo(userId) { localStorage.setItem('la.demoUser', userId); localStorage.removeItem('la.ws'); workspaceId = null; await loadMe(); },
    async signOut() {
      if (supabase) await supabase.auth.signOut();
      localStorage.removeItem('la.demoUser'); localStorage.removeItem('la.ws');
      workspaceId = null; setMe(null);
    },
    reload: loadMe,
  }), [status, me, wsId, loadMe]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

/** Small data hook: load(path) with reload.
 *  refreshMs: also reload quietly in the background on that interval (lists that change on their own).
 *  Every page also reloads quietly when the browser tab regains focus. */
export function useApi(path, { refreshMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try { setState({ data: await api(path), error: null, loading: false }); } catch (e) {
      // A failed background refresh keeps the data already on screen.
      setState((s) => (quiet && s.data ? s : { data: null, error: e, loading: false }));
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const quiet = () => { if (document.visibilityState === 'visible') load({ quiet: true }); };
    window.addEventListener('focus', quiet);
    document.addEventListener('visibilitychange', quiet);
    const t = refreshMs ? setInterval(quiet, refreshMs) : null;
    return () => { window.removeEventListener('focus', quiet); document.removeEventListener('visibilitychange', quiet); if (t) clearInterval(t); };
  }, [load, refreshMs]);
  return { ...state, reload: () => load() };
}
