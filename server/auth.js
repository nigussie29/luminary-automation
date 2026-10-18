// Identity provider. Live: Supabase Auth — every request's access token is verified with Supabase
// (only the public anon key is needed; no service-role secret). Demo: sample users, no password,
// ONLY when Supabase is not configured.
import { HttpError } from './errors.js';

export const DEMO_USERS = [
  { id: '00000000-0000-4000-8000-00000000a001', email: 'maya@brightpath.demo', name: 'Maya (Owner, Bright Path)' },
  { id: '00000000-0000-4000-8000-00000000a002', email: 'jordan@brightpath.demo', name: 'Jordan (Staff, Bright Path)' },
  { id: '00000000-0000-4000-8000-00000000b001', email: 'sam@summit.demo', name: 'Sam (Owner, Summit Learning)' },
];

export async function createIdentity(config, { fetchImpl } = {}) {
  if (config.demoAuth) {
    return {
      mode: 'demo',
      async verify(token) {
        const id = token?.startsWith('demo:') ? token.slice(5) : null;
        const u = DEMO_USERS.find((x) => x.id === id);
        if (!u) throw new HttpError(401, 'Not signed in');
        return { id: u.id, email: u.email, emailVerified: true };
      },
    };
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
  // Small cache so a page that fires 5 API calls doesn't verify the same token 5 times.
  const cache = new Map();
  return {
    mode: 'supabase',
    async verify(token) {
      if (!token) throw new HttpError(401, 'Not signed in');
      const hit = cache.get(token);
      if (hit && hit.until > Date.now()) return hit.user;
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) throw new HttpError(401, 'Session expired. Please sign in again.');
      const user = { id: data.user.id, email: data.user.email, emailVerified: Boolean(data.user.email_confirmed_at) };
      if (cache.size > 5000) cache.clear();
      cache.set(token, { user, until: Date.now() + 30_000 });
      return user;
    },
  };
}
