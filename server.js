import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { isValidAddress, resolveAccountAddress, getExtraAgents, normalizeExtraAgents, normalizeFills, normalizeFunding, getUserFillsByTime, getUserFunding } from './hyperliquid.js';
import { assembleAccount } from './account.js';
import { backfillWallet } from './backfill.js';
import { createStream } from './hl-stream.js';
import { attachWsHub } from './ws-server.js';
import { toCsv, buildPreamble, buildDetailedRows, buildKoinlyRows, isValidTimeZone, DETAILED_COLUMNS, KOINLY_COLUMNS } from './export.js';
import { METRICS, SCOPES, OPERATORS, isValidMetric } from './alerts.js';
import { createNotifier } from './notifier.js';
import { createAlertRunner } from './alert-runner.js';

// Query params are untrusted strings (or arrays, for repeated params). Coerce to a
// finite integer, falling back to `dflt` for anything that isn't one.
function toSafeInt(v, dflt) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : dflt;
}

// The widest epoch the ECMAScript Date can represent; beyond it toISOString throws.
const MAX_EPOCH_MS = 8.64e15;
const clampEpoch = (n) => Math.min(MAX_EPOCH_MS, Math.max(-MAX_EPOCH_MS, n));

// Validates an incoming alert rule. Returns { rule } or { error }; every rejection
// names the offending field, matching how the export and wallet routes explain
// themselves.
function validateAlert(body) {
  const address = String(body?.address || '').toLowerCase();
  if (!isValidAddress(address)) return { error: 'Invalid wallet address. Expected 0x followed by 40 hex characters.' };

  const scope = String(body?.scope || '');
  if (!SCOPES.includes(scope)) return { error: `Unknown scope "${scope}". Expected "account" or "position".` };

  const metric = String(body?.metric || '');
  if (!isValidMetric(scope, metric)) return { error: `Metric "${metric}" is not available for scope "${scope}".` };

  const operator = String(body?.operator || '');
  if (!OPERATORS.includes(operator)) return { error: `Unknown operator "${operator}". Expected "above" or "below".` };

  // Number('') is 0, so an empty threshold would otherwise sail through as a
  // legitimate zero — a rule the user never meant to write.
  const raw = body?.threshold;
  const threshold = raw === '' || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(threshold)) return { error: 'Threshold must be a finite number.' };

  const coin = scope === 'position' ? String(body?.coin || '').trim() : null;
  if (scope === 'position' && !coin) return { error: 'A position alert requires a coin.' };

  return { rule: { address, scope, coin, metric, operator, threshold } };
}

export function createApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  // A default no-op notifier keeps every existing test — and a server started
  // without alerts wired — working unchanged.
  const {
    stream = null,
    runner = null,
    notifier = { configured: false, send: async () => ({ sent: false, reason: 'not-configured' }) },
    ...rest
  } = overrides;
  const opts = { apiUrl: config.hlApiUrl, snapshotMinIntervalMs: config.snapshotMinIntervalMs, ...rest };

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));

  app.get('/api/config', (_req, res) => res.json({ defaultWallet: config.defaultWallet || null }));

  app.get('/api/account/:address', async (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address. Expected 0x followed by 40 hex characters.' });
    try {
      const payload = await assembleAccount(address, db, opts);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: `Failed to load account from Hyperliquid: ${err.message}` });
    }
  });

  app.get('/api/history/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const since = Number(req.query.since) || 0;
    res.json({ address, points: db.getHistory(address, since) });
  });

  app.get('/api/fills/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    // Clamp server-side so a hand-crafted request can't ask for the whole table.
    // Must land on a safe integer: SQLite rejects fractional/Infinity/oversized
    // LIMIT-OFFSET bindings, which would surface as an unhandled 500.
    const limit = Math.min(200, Math.max(1, toSafeInt(req.query.limit, 50) || 50));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, toSafeInt(req.query.offset, 0)));
    const closesOnly = req.query.closesOnly === 'true';
    res.json({
      address,
      fills: db.listFills(address, { limit, offset, closesOnly }),
      total: db.countFills(address, { closesOnly }),
      limit,
      offset,
    });
  });

  app.get('/api/range/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    res.json({ address, ...db.getRange(address) });
  });

  app.get('/api/export/:address.csv', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const format = String(req.query.format || 'detailed');
    if (format !== 'detailed' && format !== 'koinly') {
      return res.status(400).json({ error: `Unknown format "${format}". Expected "detailed" or "koinly".` });
    }
    // Bounds are computed client-side from the browser's timezone and sent as
    // explicit epoch ms, so server and client can't disagree on where a year starts.
    // Clamped into the range Date accepts: toSafeInt only guarantees finite, and an
    // out-of-range epoch makes toISOString throw inside the preamble — a 500 with a
    // stack trace rather than a CSV.
    const from = clampEpoch(toSafeInt(req.query.from, 0));
    const to = clampEpoch(toSafeInt(req.query.to, MAX_EPOCH_MS));
    // Reject a bogus zone instead of silently formatting in UTC while the preamble
    // claims otherwise — the file's whole job is to be self-describing.
    const tz = String(req.query.tz || 'UTC');
    if (!isValidTimeZone(tz)) {
      return res.status(400).json({ error: `Unknown timezone "${tz}". Expected an IANA name such as "America/New_York".` });
    }

    const fills = db.listFillsRange(address, from, to);
    const funding = db.listFunding(address, from, to);

    let csv;
    if (format === 'koinly') {
      // No preamble: a vendor import must start at the header row.
      csv = toCsv(buildKoinlyRows(fills, funding, tz), KOINLY_COLUMNS);
    } else {
      const preamble = buildPreamble({
        address,
        from: req.query.from == null ? null : from,
        to: req.query.to == null ? null : to,
        tz,
        generatedAt: Date.now(),
      });
      csv = toCsv(buildDetailedRows(fills, funding, tz), DETAILED_COLUMNS, preamble);
    }

    const label = req.query.label ? String(req.query.label).replace(/[^\w-]/g, '') : 'all';
    const filename = `hyperliquid-${address.slice(0, 10)}-${label}-${format}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  });

  app.get('/api/wallets', (_req, res) => res.json({ wallets: db.listWallets() }));

  app.post('/api/wallets', async (req, res) => {
    const entered = String(req.body?.address || '').toLowerCase();
    const label = req.body?.label ? String(req.body.label).slice(0, 60) : null;
    if (!isValidAddress(entered)) return res.status(400).json({ error: 'Invalid wallet address.' });
    try {
      const resolved = await resolveAccountAddress(entered, opts);
      db.upsertWallet(resolved.address, label, resolved.viaAgent);
      res.json({ wallets: db.listWallets(), resolved: { entered, ...resolved } });
    } catch (err) {
      res.status(500).json({ error: `Failed to add wallet: ${err.message}` });
    }
  });

  app.post('/api/backfill/:address', async (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    try {
      // Resume cursors from a previous truncated run; absent on a first sync.
      const result = await backfillWallet(address, db, {
        fillsFrom: clampEpoch(toSafeInt(req.query.fillsFrom, 0)),
        fundingFrom: clampEpoch(toSafeInt(req.query.fundingFrom, 0)),
        // The backfill's source is the authoritative historical record, so an
        // omitted builderFee here means no builder took a cut — a definite 0, not
        // the "unknown" the live path records. Resolving it at this one boundary
        // keeps NULL meaning "never confirmed" everywhere else, which is what lets
        // the COALESCE upsert repair it.
        fetchFills: async (since) => normalizeFills(await getUserFillsByTime(address, opts, since))
          .rows.map((r) => ({ ...r, builder_fee: r.builder_fee ?? 0 })),
        fetchFunding: async (since) => normalizeFunding(await getUserFunding(address, opts, since)),
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: `Backfill failed: ${err.message}` });
    }
  });

  app.delete('/api/wallets/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    db.deleteWallet(address);
    // Without this the live userFills subscription re-inserts the fills we just purged.
    stream?.untrack(address);
    // The alerts cascade away with the wallet, so the runner's webData2 reference
    // for it is now paying for data nothing reads.
    runner?.unwatch(address);
    res.json({ wallets: db.listWallets() });
  });

  app.get('/api/agents/:address', async (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    try {
      const agents = normalizeExtraAgents(await getExtraAgents(address, opts));
      res.json({ address, agents });
    } catch (err) {
      res.status(502).json({ error: `Failed to load connected agents: ${err.message}` });
    }
  });

  app.get('/api/alerts', (req, res) => {
    const address = String(req.query.address || '').toLowerCase();
    // Required, deliberately: without it this would list every wallet's rules.
    if (!isValidAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    // METRICS rides along so the UI builds its dropdowns from the same whitelist
    // the validator enforces, rather than a hand-copied duplicate that can drift.
    res.json({ address, alerts: db.listAlerts(address), metrics: METRICS, emailConfigured: notifier.configured });
  });

  app.post('/api/alerts', (req, res) => {
    const { error, rule } = validateAlert(req.body);
    if (error) return res.status(400).json({ error });
    // Alerts are evaluated per watched wallet, so a rule on an unwatched address
    // would never fire — refuse it rather than store something inert.
    if (!db.hasWallet(rule.address)) {
      return res.status(400).json({ error: 'Add the wallet to the watch list before creating alerts for it.' });
    }
    const alert = db.createAlert(rule);
    // A brand new alerting wallet needs its webData2 subscription now, not at the
    // next restart.
    runner?.watch(rule.address);
    res.json({ alert });
  });

  app.patch('/api/alerts/:id', (req, res) => {
    const id = toSafeInt(req.params.id, NaN);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid alert id.' });

    const body = req.body || {};
    const patch = {};
    if ('enabled' in body) patch.enabled = body.enabled ? 1 : 0;
    if ('threshold' in body) {
      const threshold = body.threshold === '' || body.threshold == null ? NaN : Number(body.threshold);
      if (!Number.isFinite(threshold)) return res.status(400).json({ error: 'Threshold must be a finite number.' });
      patch.threshold = threshold;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update. Send "enabled" or "threshold".' });

    const alert = db.updateAlert(id, patch);
    if (!alert) return res.status(404).json({ error: 'No such alert.' });
    // POST watches on create; a rule coming back from paused needs the same, or
    // it lives on an address the runner holds no webData2 reference for and only
    // the slow backstop sweep ever reaches it.
    if (alert.enabled) runner?.watch(alert.address);
    res.json({ alert });
  });

  app.delete('/api/alerts/:id', (req, res) => {
    const id = toSafeInt(req.params.id, NaN);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid alert id.' });
    if (!db.deleteAlert(id)) return res.status(404).json({ error: 'No such alert.' });
    res.json({ ok: true });
  });

  app.post('/api/alerts/test', async (req, res) => {
    // 503 rather than a cheerful 200: a test button that succeeds without sending
    // anything is worse than no button.
    if (!notifier.configured) {
      return res.status(503).json({ error: 'Email is not configured. Set SMTP_HOST and ALERT_EMAIL_TO in .env.' });
    }
    try {
      await notifier.send({ subject: '[Hyperbal] Test alert', text: 'Email is configured correctly.' });
      res.json({ sent: true });
    } catch (err) {
      res.status(502).json({ error: `Failed to send: ${err.message}` });
    }
  });

  app.use(express.static('public'));
  return app;
}

if (process.argv[1]?.endsWith('server.js')) {
  const db = openDb(config.dbPath);
  const stream = createStream({ wsUrl: config.hlWsUrl });
  const notifier = createNotifier(config);
  const runner = createAlertRunner({
    db,
    stream,
    notifier,
    opts: {
      apiUrl: config.hlApiUrl,
      snapshotMinIntervalMs: config.snapshotMinIntervalMs,
      alertCooldownMs: config.alertCooldownMs,
      alertDebounceMs: config.alertDebounceMs,
      alertPollIntervalMs: config.alertPollIntervalMs,
      dashboardUrl: config.dashboardUrl,
    },
  });
  const app = createApp(db, { stream, notifier, runner });
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));

  stream.start();
  // Re-track all previously-watched wallets so fills accumulate even before a browser connects.
  for (const w of db.listWallets()) stream.track(w.address);
  // Same idea for account state: one webData2 subscription per alerting wallet, so
  // alerts fire with no browser open.
  runner.start();

  if (!notifier.configured) {
    console.log('[alerts] SMTP is not configured — alerts will evaluate and log, but not email.');
  }

  attachWsHub(server, { db, stream });
}
