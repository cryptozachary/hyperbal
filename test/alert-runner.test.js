import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAlertRunner } from '../alert-runner.js';

const NOW = 1_700_000_000_000;
const OPTS = { alertCooldownMs: 900000, alertDebounceMs: 5000, alertPollIntervalMs: 300000, dashboardUrl: 'http://localhost:3005' };

const PAYLOAD = {
  equity: 1000, marginUsed: 100, totalUnrealizedPnl: -50, openPositionsCount: 1,
  positions: [{ coin: 'BTC', size: 0.5, side: 'LONG', entryPrice: 60000, markPrice: 58000,
    liquidationPrice: 52200, leverage: 5, marginUsed: 5800, unrealizedPnl: -1000, roe: -16.67 }],
};

// Records every saveAlertResult call so the tests can assert on persistence.
function fakeDb(rules = []) {
  return {
    saved: [],
    listEnabledAlerts(address) { return rules.filter((r) => r.address === address); },
    alertAddresses() { return [...new Set(rules.map((r) => r.address))]; },
    saveAlertResult(id, result) { this.saved.push({ id, ...result }); },
  };
}

function fakeNotifier({ configured = true, fail = false } = {}) {
  const sent = [];
  return {
    configured, sent,
    async send(mail) {
      if (fail) throw new Error('smtp down');
      sent.push(mail);
      return { sent: configured };
    },
  };
}

const rule = (over = {}) => ({
  id: 1, address: '0xaaa', scope: 'account', coin: null, metric: 'equity',
  operator: 'below', threshold: 5000, enabled: 1,
  last_state: 0, last_attempt_at: null, last_fired_at: null, ...over,
});

const build = (rules, notifier, over = {}) => createAlertRunner({
  db: fakeDb(rules), stream: new EventEmitter(), notifier,
  opts: OPTS, now: () => NOW, assemble: async () => PAYLOAD, ...over,
});

test('a firing rule sends one email and records both timestamps', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule()], notifier);
  await runner.evaluateAddress('0xaaa');

  assert.equal(notifier.sent.length, 1);
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 1, attemptAt: NOW, firedAt: NOW }]);
});

test('the email carries the rule, the value, and the dashboard url', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule({ scope: 'position', coin: 'BTC', metric: 'unrealizedPnl', threshold: -500 })], notifier);
  await runner.evaluateAddress('0xaaa');

  const mail = notifier.sent[0];
  assert.match(mail.subject, /BTC unrealized PnL below -\$500/);
  assert.match(mail.subject, /-\$1,000/);      // the observed value
  assert.match(mail.text, /0xaaa/);            // which wallet
  assert.match(mail.text, /http:\/\/localhost:3005/);
  assert.match(mail.text, /BTC LONG/);         // the position summary
});

test('an account-scope email summarizes the account', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule()], notifier);
  await runner.evaluateAddress('0xaaa');
  assert.match(notifier.sent[0].text, /Equity: \$1,000/);
});

test('a non-firing rule persists state and no timestamps', async () => {
  const notifier = fakeNotifier();
  // equity 1000 is not above 5000 -> condition false.
  const runner = build([rule({ operator: 'above' })], notifier);
  await runner.evaluateAddress('0xaaa');

  assert.equal(notifier.sent.length, 0);
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 0 }]);
});

test('a send failure keeps the old state so the rule retries', async () => {
  const notifier = fakeNotifier({ fail: true });
  const runner = build([rule({ last_state: 0 })], notifier);
  await runner.evaluateAddress('0xaaa');

  // last_state stays 0 -> the next pass past the cooldown fires again.
  // attemptAt advances -> that retry is throttled, not immediate.
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 0, attemptAt: NOW }]);
});

test('an unconfigured notifier advances state but never claims it fired', async () => {
  const notifier = fakeNotifier({ configured: false });
  const runner = build([rule()], notifier);
  await runner.evaluateAddress('0xaaa');

  // firedAt stays null: last_fired_at must never assert an email that did not go out.
  assert.deepEqual(runner.db.saved, [{ id: 1, lastState: 1, attemptAt: NOW, firedAt: null }]);
});

test('an assembleAccount failure is caught and changes nothing', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule()], notifier, { assemble: async () => { throw new Error('hyperliquid down'); } });
  await runner.evaluateAddress('0xaaa'); // must not reject

  assert.equal(notifier.sent.length, 0);
  assert.deepEqual(runner.db.saved, []);
});

test('an address with no enabled rules does no work', async () => {
  let assembled = 0;
  const runner = build([], fakeNotifier(), { assemble: async () => { assembled++; return PAYLOAD; } });
  await runner.evaluateAddress('0xzzz');
  assert.equal(assembled, 0);
});

test('start watches each alerting address exactly once', () => {
  const watched = [];
  const stream = Object.assign(new EventEmitter(), { watch: (a) => watched.push(a) });
  const runner = build([rule({ id: 1 }), rule({ id: 2 })], fakeNotifier(), { stream });

  runner.start();
  runner.watch('0xaaa');  // a newly created rule for an address already watched
  assert.deepEqual(watched, ['0xaaa']); // two rules, one subscription, no refcount leak

  runner.watch('0xbbb');
  assert.deepEqual(watched, ['0xaaa', '0xbbb']);
  runner.stop();
});

test('sweep evaluates every alerting address', async () => {
  const notifier = fakeNotifier();
  const runner = build([rule({ id: 1, address: '0xaaa' }), rule({ id: 2, address: '0xbbb' })], notifier);
  await runner.sweep();
  assert.deepEqual(runner.db.saved.map((s) => s.id), [1, 2]);
});
