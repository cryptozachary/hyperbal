import { WebSocketServer } from 'ws';
import { isValidAddress } from './hyperliquid.js';

// Attaches a WS hub at /ws to an existing http.Server.
export function attachWsHub(httpServer, { db, stream }) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const watching = new Map(); // ws client -> address

  function broadcast(address, payload) {
    const msg = JSON.stringify(payload);
    for (const [client, addr] of watching) {
      if (addr === address && client.readyState === client.OPEN) client.send(msg);
    }
  }

  // allMids carries no user, so one tick means "prices moved" and every watched
  // wallet is potentially stale. Throttled: the feed ticks every few seconds and
  // each refresh costs the client a full account re-fetch across every perp dex.
  let lastRefreshAt = 0;
  const REFRESH_MIN_INTERVAL_MS = 10000;
  stream.on('mids', () => {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
    lastRefreshAt = now;
    for (const [client, address] of watching) {
      if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: 'refresh', address }));
    }
  });

  // Persist + relay live fills. Rows ride along on this message so one upstream
  // event produces exactly one downstream message.
  stream.on('fills', ({ address, rows, recentRealized }) => {
    if (!address) return;
    // A userFills message can already be in flight when the wallet is deleted and
    // untracked; ingesting it would re-create rows the purge just removed.
    if (!db.hasWallet(address)) return;
    db.ingestFills(address, rows);
    broadcast(address, { type: 'realized', address,
      realizedPnlCumulative: db.cumulativeRealized(address), realizedPnlRecent: recentRealized, fills: rows });
  });

  wss.on('connection', (client) => {
    client.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'watch') {
        const address = String(msg.address || '').toLowerCase();
        if (!isValidAddress(address)) { client.send(JSON.stringify({ type: 'error', message: 'Invalid address' })); return; }
        const prev = watching.get(client);
        if (prev === address) return; // already watching this exact address — keep watch idempotent (no ref-count leak)
        if (prev) stream.unwatch(prev);
        watching.set(client, address);
        // Only re-arm the persistent userFills sub for wallets still on the watch
        // list — otherwise a stale tab reconnecting would undo a delete's untrack.
        if (db.hasWallet(address)) stream.track(address);
        stream.watch(address);  // ref-counts the global allMids price feed
      }
    });
    client.on('close', () => {
      const addr = watching.get(client);
      if (addr) stream.unwatch(addr);
      watching.delete(client);
    });
  });

  return wss;
}
