import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createAi } from './ai/index.js';
import { createEmail } from './integrations/email.js';
import { createIdentity } from './auth.js';
import { createServices } from './services.js';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.pgliteDir || undefined });
const ai = createAi(config);
const email = createEmail(config);
const identity = await createIdentity(config);
const services = createServices({ db, ai, email, identity });

if (db.kind === 'pglite' && config.seedDemo) await seedDemo({ db, ai, email, identity });

const integrations = {
  auth: identity.mode === 'supabase' ? 'live' : 'demo',
  database: db.kind === 'postgres' ? 'live' : (config.pgliteDir ? 'local-file' : 'in-memory'),
  ai: ai.live ? 'live' : 'simulated',
  ai_model: ai.model,
  email: email.live ? 'live' : 'simulated',
  calendar: 'internal', // appointments are tracked in-app; no external calendar sync in this version
};

const app = createApp({ services, identity, config, integrations });
app.listen(config.port, () => {
  console.log(`Luminary Automation API on http://localhost:${config.port}`);
  console.log('Integrations:', integrations);
  if (identity.mode === 'demo') console.log('DEMO MODE: sample data, password-free demo users. Configure Supabase for real accounts.');
});

// Reminder engine. Safe to run on several instances: reminders are claimed atomically.
const tick = () => services.runDueReminders()
  .then((r) => r.processed && console.log(`[reminders] processed ${r.processed}`))
  .catch((e) => console.error('[reminders] run failed', e));
setInterval(tick, config.reminderIntervalMs).unref();
tick();
