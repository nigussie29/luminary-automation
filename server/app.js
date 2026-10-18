import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, notFound } from './errors.js';
import { DEMO_USERS } from './auth.js';
import { PLANS, STAGES } from './rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Very small fixed-window rate limiter for the public form (per IP). */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip;
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) hits.set(key, { start: now, n: 1 });
    else if (++h.n > max) return next(new HttpError(429, 'Too many submissions. Please try again later.'));
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

export function createApp({ services: svc, identity, config, integrations }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });

  const api = express.Router();
  api.param('id', (_req, _res, next, id) => (UUID.test(id) ? next() : next(notFound())));
  api.param('userId', (_req, _res, next, id) => (UUID.test(id) ? next() : next(notFound())));

  // -------------------------------------------------- public
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.get('/status', (_req, res) => res.json({
    demo: identity.mode === 'demo',
    integrations,
    supabase: identity.mode === 'supabase' ? { url: config.supabaseUrl, anonKey: config.supabaseAnonKey } : null,
    plans: PLANS,
    stages: STAGES,
  }));
  api.get('/demo/users', (_req, res) => {
    if (identity.mode !== 'demo') throw notFound();
    res.json(DEMO_USERS);
  });
  // Other sites you own (e.g. the Luminary Academy enrollment form) may post inquiries here.
  // Only origins listed in ALLOWED_ORIGINS get CORS headers; everything else is same-origin only.
  api.use('/public', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST');
      res.set('Access-Control-Allow-Headers', 'content-type');
      res.set('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(origin && config.allowedOrigins.includes(origin) ? 204 : 403);
    next();
  });
  api.get('/public/forms/:slug', async (req, res) => res.json(await svc.publicForm(req.params.slug)));
  api.post('/public/forms/:slug/inquiries', rateLimit({ windowMs: 10 * 60_000, max: 10 }), async (req, res) => {
    const r = await svc.submitInquiry(req.params.slug, req.body || {}, { deferProcessing: true });
    res.status(201).json({ ok: true, message: 'Thanks! We received your message and will reply soon.' });
    if (r.leadId && !r.duplicate) {
      svc.processNewLead(r.leadId).catch((e) => console.error('[workflow] processing failed', r.leadId, e));
    }
  });
  // Scheduled job endpoint (e.g. Railway cron or an uptime pinger). Requires CRON_SECRET.
  api.post('/cron/reminders', async (req, res) => {
    if (!config.cronSecret || req.get('x-cron-secret') !== config.cronSecret) throw new HttpError(401, 'Unauthorized');
    const r = await svc.runDueReminders();
    res.json({ processed: r.processed });
  });

  // -------------------------------------------------- authenticated
  api.use(async (req, _res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    req.user = await identity.verify(token);
    next();
  });
  api.get('/me', async (req, res) => res.json({ user: req.user, workspaces: await svc.myWorkspaces(req.user) }));
  api.post('/workspaces', async (req, res) => res.status(201).json(await svc.createWorkspace(req.user, req.body || {})));

  // Demo only: lets you trigger the reminder engine instead of waiting for the schedule.
  api.post('/demo/run-reminders', async (_req, res) => {
    if (identity.mode !== 'demo') throw notFound();
    const r = await svc.runDueReminders();
    res.json({ processed: r.processed });
  });

  // Every route below requires membership in the workspace named by X-Workspace-Id.
  api.use(async (req, _res, next) => {
    const wsId = req.get('x-workspace-id');
    if (!wsId || !UUID.test(wsId)) throw new HttpError(400, 'Missing workspace');
    req.ctx = await svc.resolveContext(req.user.id, wsId);
    next();
  });
  const c = (req) => req.ctx;

  api.get('/dashboard', async (req, res) => res.json(await svc.dashboard(c(req), req.query)));
  api.get('/leads', async (req, res) => res.json(await svc.listLeads(c(req), req.query)));
  api.get('/leads/:id', async (req, res) => res.json(await svc.getLead(c(req), req.params.id)));
  api.patch('/leads/:id', async (req, res) => res.json(await svc.updateLead(c(req), req.params.id, req.body || {})));
  api.post('/leads/:id/stage', async (req, res) => res.json(await svc.changeStage(c(req), req.params.id, req.body?.stage, req.body || {})));
  api.post('/leads/:id/draft', async (req, res) => res.status(201).json(await svc.regenerateDraft(c(req), req.params.id)));
  api.post('/leads/:id/messages', async (req, res) => res.status(201).json(await svc.createManualMessage(c(req), req.params.id, req.body || {})));
  api.post('/leads/:id/appointments', async (req, res) => res.status(201).json(await svc.bookAppointment(c(req), req.params.id, req.body || {})));

  api.get('/queue', async (req, res) => res.json(await svc.listQueue(c(req))));
  api.patch('/messages/:id', async (req, res) => res.json(await svc.editMessage(c(req), req.params.id, req.body || {})));
  api.post('/messages/:id/approve', async (req, res) => res.json(await svc.approveMessage(c(req), req.params.id, req.body || {})));
  api.post('/messages/:id/reject', async (req, res) => res.json(await svc.rejectMessage(c(req), req.params.id)));

  api.get('/appointments', async (req, res) => res.json(await svc.listAppointments(c(req), { upcoming: req.query.all !== '1' })));
  api.patch('/appointments/:id', async (req, res) => res.json(await svc.updateAppointment(c(req), req.params.id, req.body || {})));
  api.get('/events', async (req, res) => res.json(await svc.listEvents(c(req), req.query)));

  api.get('/workspace', async (req, res) => res.json({ ...(await svc.getWorkspace(c(req))), role: c(req).role }));
  api.patch('/workspace', async (req, res) => res.json(await svc.updateWorkspace(c(req), req.body || {})));
  api.get('/knowledge', async (req, res) => res.json(await svc.listKnowledge(c(req))));
  api.post('/knowledge', async (req, res) => res.status(201).json(await svc.saveKnowledge(c(req), { ...req.body, id: undefined })));
  api.put('/knowledge/:id', async (req, res) => res.json(await svc.saveKnowledge(c(req), { ...req.body, id: req.params.id })));
  api.delete('/knowledge/:id', async (req, res) => res.json(await svc.deleteKnowledge(c(req), req.params.id)));
  api.get('/members', async (req, res) => res.json(await svc.listMembers(c(req))));
  api.post('/members', async (req, res) => res.status(201).json(await svc.addMember(c(req), req.body || {})));
  api.delete('/invites/:email', async (req, res) => res.json(await svc.cancelInvite(c(req), req.params.email)));
  api.delete('/members/:userId', async (req, res) => res.json(await svc.removeMember(c(req), req.params.userId)));

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  // -------------------------------------------------- frontend (production build)
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error('[api] unhandled error', err);
    res.status(500).json({ error: 'Something went wrong. The error has been logged.' });
  });
  return app;
}
