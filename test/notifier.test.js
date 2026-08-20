import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../notifier.js';

const CFG = {
  smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'me@example.com',
  smtpPass: 'secret', smtpFrom: '', alertEmailTo: 'you@example.com',
};

// Captures what would have gone over the wire. No socket is ever opened.
function fakeTransport() {
  const sent = [];
  let opts = null;
  const factory = (o) => { opts = o; return { sendMail: async (m) => { sent.push(m); return { messageId: '1' }; } }; };
  return { factory, sent, options: () => opts };
}

test('unconfigured notifier is a no-op that does not throw', async () => {
  for (const cfg of [{ ...CFG, smtpHost: '' }, { ...CFG, alertEmailTo: '' }]) {
    const n = createNotifier(cfg, { transportFactory: () => { throw new Error('must not build a transport'); } });
    assert.equal(n.configured, false);
    const result = await n.send({ subject: 's', text: 't' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'not-configured');
  }
});

test('configured notifier sends through the transport', async () => {
  const t = fakeTransport();
  const n = createNotifier(CFG, { transportFactory: t.factory });
  assert.equal(n.configured, true);

  const result = await n.send({ subject: 'hello', text: 'body' });
  assert.equal(result.sent, true);
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], {
    from: 'me@example.com', to: 'you@example.com', subject: 'hello', text: 'body',
  });
});

test('smtpFrom overrides the user as the envelope From', async () => {
  const t = fakeTransport();
  const n = createNotifier({ ...CFG, smtpFrom: 'alerts@example.com' }, { transportFactory: t.factory });
  await n.send({ subject: 's', text: 't' });
  assert.equal(t.sent[0].from, 'alerts@example.com');
});

test('port 465 is implicit TLS, everything else is not', () => {
  const a = fakeTransport();
  createNotifier({ ...CFG, smtpPort: 465 }, { transportFactory: a.factory });
  assert.equal(a.options().secure, true);

  const b = fakeTransport();
  createNotifier({ ...CFG, smtpPort: 587 }, { transportFactory: b.factory });
  assert.equal(b.options().secure, false);
});

test('auth is omitted when no user is configured', () => {
  const t = fakeTransport();
  createNotifier({ ...CFG, smtpUser: '' }, { transportFactory: t.factory });
  assert.equal(t.options().auth, undefined);
});

test('a transport failure propagates', async () => {
  const n = createNotifier(CFG, {
    transportFactory: () => ({ sendMail: async () => { throw new Error('550 rejected'); } }),
  });
  await assert.rejects(() => n.send({ subject: 's', text: 't' }), /550 rejected/);
});
