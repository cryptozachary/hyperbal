import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { isValidAddress, resolveAccountAddress, getExtraAgents, normalizeExtraAgents, normalizeFills, normalizeFunding, getUserFillsByTime, getUserFunding } from './hyperliquid.js';
import { assembleAccount } from './account.js';
import { backfillWallet } from './backfill.js';
import { createStream } from './hl-stream.js';
import { attachWsHub } from './ws-server.js';
import { toCsv, buildPreamble, buildDetailedRows, buildKoinlyRows, isValidTimeZone, DETAILED_COLUMNS, KOINLY_COLUMNS } from './export.js';

// Query params are untrusted strings (or arrays, for repeated params). Coerce to a
// finite integer, falling back to `dflt` for anything that isn't one.
function toSafeInt(v, dflt) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : dflt;
}

// The widest epoch the ECMAScript Date can represent; beyond it toISOString throws.
const MAX_EPOCH_MS = 8.64e15;
const clampEpoch = (n) => Math.min(MAX_EPOCH_MS, Math.max(-MAX_EPOCH_MS, n));

export function createApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const { stream = null, ...rest } = overrides;
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

  app.use(express.static('public'));
  return app;
}

if (process.argv[1]?.endsWith('server.js')) {
  const db = openDb(config.dbPath);
  const stream = createStream({ wsUrl: config.hlWsUrl });
  const app = createApp(db, { stream });
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));

  stream.start();
  // Re-track all previously-watched wallets so fills accumulate even before a browser connects.
  for (const w of db.listWallets()) stream.track(w.address);

  attachWsHub(server, { db, stream });
}
