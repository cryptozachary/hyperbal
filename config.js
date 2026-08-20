import 'dotenv/config';

function clean(v) {
  return (v ?? '').trim();
}

// Hoisted out of the literal below so dashboardUrl can default against the same
// resolved value rather than re-reading (and re-defaulting) process.env.PORT.
const port = Number(clean(process.env.PORT)) || 3005;

export const config = {
  port,
  hlApiUrl: clean(process.env.HL_API_URL) || 'https://api.hyperliquid.xyz/info',
  hlWsUrl: clean(process.env.HL_WS_URL) || 'wss://api.hyperliquid.xyz/ws',
  defaultWallet: clean(process.env.DEFAULT_WALLET).toLowerCase(),
  dbPath: clean(process.env.DB_PATH) || './data/hyperliquid.db',
  snapshotMinIntervalMs: Number(clean(process.env.SNAPSHOT_MIN_INTERVAL_MS)) || 60000,

  // Alerts. Every one of these is optional: with no SMTP_HOST/ALERT_EMAIL_TO the
  // notifier degrades to logging and the rest of the feature still works.
  smtpHost: clean(process.env.SMTP_HOST),
  smtpPort: Number(clean(process.env.SMTP_PORT)) || 587,
  smtpUser: clean(process.env.SMTP_USER),
  smtpPass: clean(process.env.SMTP_PASS),
  smtpFrom: clean(process.env.SMTP_FROM),
  alertEmailTo: clean(process.env.ALERT_EMAIL_TO),
  alertCooldownMs: Number(clean(process.env.ALERT_COOLDOWN_MS)) || 900000,
  alertPollIntervalMs: Number(clean(process.env.ALERT_POLL_INTERVAL_MS)) || 300000,
  // Debounces the allMids price-feed trigger. That feed ticks every few seconds
  // and each evaluation costs a full multi-dex account re-fetch, so this bounds
  // the cost to roughly four evaluations per minute per wallet.
  alertDebounceMs: Number(clean(process.env.ALERT_DEBOUNCE_MS)) || 15000,
  dashboardUrl: clean(process.env.DASHBOARD_URL) || `http://localhost:${port}`,
};
