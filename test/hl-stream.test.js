import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStream } from '../hl-stream.js';

const ADDR = '0x' + 'b'.repeat(40);

// Minimal fake ws.WebSocket
class FakeWS extends EventEmitter {
  constructor() { super(); this.sent = []; this.readyState = 1; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close'); }
  ping() {}
}
FakeWS.OPEN = 1;

function makeStream() {
  let ws;
  const factory = () => { ws = new FakeWS(); queueMicrotask(() => ws.emit('open')); return ws; };
  const stream = createStream({ wsUrl: 'wss://x', WebSocketImpl: FakeWS, wsFactory: factory });
  return { stream, getWs: () => ws };
}

test('track sends persistent userFills sub; watch ref-counts webData2', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  stream.watch(ADDR);
  const subs = getWs().sent.filter((m) => m.method === 'subscribe');
  assert.ok(subs.some((s) => s.subscription.type === 'userFills' && s.subscription.user === ADDR));
  assert.ok(subs.some((s) => s.subscription.type === 'webData2' && s.subscription.user === ADDR));
});

test('unwatch ref-counts down and unsubscribes at zero', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.watch(ADDR);
  stream.watch(ADDR);          // count = 2
  stream.unwatch(ADDR);        // count = 1, no unsubscribe yet
  let unsubs = getWs().sent.filter((m) => m.method === 'unsubscribe');
  assert.equal(unsubs.length, 0);
  stream.unwatch(ADDR);        // count = 0, unsubscribe
  unsubs = getWs().sent.filter((m) => m.method === 'unsubscribe' && m.subscription.type === 'webData2');
  assert.equal(unsubs.length, 1);
});

test('untrack unsubscribes userFills and drops it from the reconnect set', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  stream.untrack(ADDR);
  const unsubs = getWs().sent.filter((m) => m.method === 'unsubscribe' && m.subscription.type === 'userFills');
  assert.equal(unsubs.length, 1);
  assert.equal(unsubs[0].subscription.user, ADDR);

  // untracking twice must not send a second unsubscribe
  stream.untrack(ADDR);
  assert.equal(getWs().sent.filter((m) => m.method === 'unsubscribe' && m.subscription.type === 'userFills').length, 1);

  // on reconnect the address must not be resubscribed
  const before = getWs();
  before.emit('close');
  await new Promise((r) => setTimeout(r, 1100));
  const resubs = getWs().sent.filter((m) => m.method === 'subscribe' && m.subscription.type === 'userFills');
  assert.equal(resubs.length, 0);
});

test('webData2 message emits normalized account with address', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.watch(ADDR);
  const got = new Promise((resolve) => stream.on('account', resolve));
  getWs().emit('message', JSON.stringify({
    channel: 'webData2',
    data: { user: ADDR, clearinghouseState: { marginSummary: { accountValue: '10' }, assetPositions: [] } },
  }));
  const evt = await got;
  assert.equal(evt.address, ADDR);
  assert.equal(evt.account.equity, 10);
});

test('userFills message emits normalized fills with address', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  const got = new Promise((resolve) => stream.on('fills', resolve));
  getWs().emit('message', JSON.stringify({
    channel: 'userFills',
    data: { user: ADDR, isSnapshot: true, fills: [
      { tid: 7, coin: 'BTC', closedPnl: '3', fee: '0.1', px: '100', sz: '1', side: 'B', time: 1 },
    ] },
  }));
  const evt = await got;
  assert.equal(evt.address, ADDR);
  assert.equal(evt.rows.length, 1);
  assert.equal(evt.rows[0].tid, 7);
  assert.equal(evt.recentRealized, 3);
});

test('normalized fill rows carry the fields the hub broadcasts', async () => {
  const { stream, getWs } = makeStream();
  stream.start();
  await new Promise((r) => setTimeout(r, 5));
  stream.track(ADDR);
  const got = new Promise((resolve) => stream.on('fills', resolve));
  getWs().emit('message', JSON.stringify({
    channel: 'userFills',
    data: { user: ADDR, fills: [
      { tid: 9, coin: 'BTC', closedPnl: '3', fee: '0.1', px: '100', sz: '1', side: 'A', dir: 'Close Long', time: 5 },
    ] },
  }));
  const evt = await got;
  assert.equal(evt.rows[0].dir, 'Close Long');
  assert.equal(evt.rows[0].coin, 'BTC');
  assert.equal(evt.rows[0].ts, 5);
});
