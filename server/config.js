export function loadConfig(env = process.env) {
  const supabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  return {
    port: Number(env.PORT || 8787),
    production: env.NODE_ENV === 'production',
    appUrl: env.APP_URL || 'http://localhost:5173',
    databaseUrl: env.DATABASE_URL || '',
    pgliteDir: env.PGLITE_DIR || '',          // optional: persist demo data to disk
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    // Demo auth (pick a sample user, no password) is ONLY possible when Supabase auth is not configured.
    demoAuth: !supabaseConfigured,
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    aiModel: env.AI_MODEL || 'claude-haiku-5-5',
    // ASSUMPTION: Haiku 5.5 list price, USD per million tokens (check current pricing).
    aiInputCostPerMTok: Number(env.AI_INPUT_COST_PER_MTOK || 0.10),
    aiOutputCostPerMTok: Number(env.AI_OUTPUT_COST_PER_MTOK || 0.50),
    resendKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    cronSecret: env.CRON_SECRET || '',
    // Comma-separated sites allowed to post to the public inquiry form, e.g. https://theluminaryacademy.net
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean),
    reminderIntervalMs: Number(env.REMINDER_INTERVAL_MS || 60_000),
    seedDemo: env.SEED_DEMO !== 'false',
  };
}
