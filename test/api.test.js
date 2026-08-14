import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../public/js/api.js';

// Swap globalThis.fetch for the duration of one call and capture what was requested.
async function withFetch(impl, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, opts) => { calls.push({ path, opts }); return impl(path, opts); };
  try { return { result: await run(), calls }; }
  finally { globalThis.fetch = original; }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('a successful request returns the parsed body', async () => {
  const { result, calls } = await withFetch(() => ok({ wallets: [] }), () => api.getWallets());
  assert.deepEqual(result, { wallets: [] });
  assert.equal(calls[0].path, '/api/wallets');
});

test('an error response surfaces the server message and its status', async () => {
  const res = { ok: false, status: 400, json: async () => ({ error: 'Invalid wallet address.' }) };
  await withFetch(() => res, async () => {
    await assert.rejects(api.getAccount('0xnope'), (err) => {
      assert.equal(err.message, 'Invalid wallet address.');
      assert.equal(err.status, 400);
      assert.equal(err.offline, undefined);
      return true;
    });
  });
});

test('a non-JSON error body falls back to the status line', async () => {
  const res = { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  await withFetch(() => res, async () => {
    await assert.rejects(api.getWallets(), (err) => {
      assert.equal(err.message, 'Request failed (404)');
      assert.equal(err.status, 404);
      return true;
    });
  });
});

test('an unreachable server is marked offline and keeps its original message', async () => {
  await withFetch(() => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(api.getConfig(), (err) => {
      assert.equal(err.offline, true);
      assert.equal(err.message, 'Failed to fetch');  // NOT rewritten — Task 5 owns that
      assert.equal(err.status, undefined);
      return true;
    });
  });
});

test('getFills sends only the three query fields, ignoring the rest of the fills state', async () => {
  const state = { rows: [1, 2, 3], total: 99, limit: 50, offset: 100, closesOnly: true };
  const { calls } = await withFetch(() => ok({ fills: [], total: 0 }), () => api.getFills('0xabc', state));
  assert.equal(calls[0].path, '/api/fills/0xabc?limit=50&offset=100&closesOnly=true');
});

test('backfill only sends resume cursors when resuming', async () => {
  const bare = await withFetch(() => ok({}), () => api.backfill('0xabc'));
  assert.equal(bare.calls[0].path, '/api/backfill/0xabc');
  assert.equal(bare.calls[0].opts.method, 'POST');

  const resumed = await withFetch(() => ok({}), () => api.backfill('0xabc', { fills: 10, funding: 20 }));
  assert.equal(resumed.calls[0].path, '/api/backfill/0xabc?fillsFrom=10&fundingFrom=20');
});

test('addWallet posts JSON', async () => {
  const { calls } = await withFetch(() => ok({ resolved: null }), () => api.addWallet('0xabc'));
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { address: '0xabc' });
});
