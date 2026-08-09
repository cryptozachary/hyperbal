import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { isValidAddress, resolveAccountAddress, getExtraAgents, normalizeExtraAgents } from './hyperliquid.js';
import { assembleAccount } from './account.js';
import { createStream } from './hl-stream.js';
import { attachWsHub } from './ws-server.js';

// Query params are untrusted strings (or arrays, for repeated params). Coerce to a
// finite integer, falling back to `dflt` for anything that isn't one.
function toSafeInt(v, dflt) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : dflt;
}

export function createApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const opts = { apiUrl: config.hlApiUrl, snapshotMinIntervalMs: config.snapshotMinIntervalMs, ...overrides };

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

  app.delete('/api/wallets/:address', (req, res) => {
    const address = String(req.params.address || '').toLowerCase();
    db.removeWallet(address);
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
  const app = createApp(db);
  const server = app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));

  const stream = createStream({ wsUrl: config.hlWsUrl });
  stream.start();
  // Re-track all previously-watched wallets so fills accumulate even before a browser connects.
  for (const w of db.listWallets()) stream.track(w.address);

  attachWsHub(server, { db, stream });
}
