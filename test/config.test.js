import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';

test('config has defaults', () => {
  assert.ok(config.port > 0);
  assert.match(config.hlApiUrl, /^https?:\/\//);
  assert.match(config.hlWsUrl, /^wss?:\/\//);
  assert.equal(typeof config.snapshotMinIntervalMs, 'number');
});
