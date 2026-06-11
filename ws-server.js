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

  // A main-dex webData2 change can't carry builder-dex state, so nudge clients to
  // re-fetch the aggregated account over REST (the single source of truth).
  stream.on('account', ({ address }) => {
    if (!address) return;
    broadcast(address, { type: 'refresh' });
  });

  // Persist + relay live fills.
  stream.on('fills', ({ address, rows, recentRealized }) => {
    if (!address) return;
    db.ingestFills(address, rows);
    broadcast(address, { type: 'realized',
      realizedPnlCumulative: db.cumulativeRealized(address), realizedPnlRecent: recentRealized });
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
        stream.track(address);  // persistent userFills
        stream.watch(address);  // live webData2
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
