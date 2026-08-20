import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';

test('config has defaults', () => {
  assert.ok(config.port > 0);
  assert.match(config.hlApiUrl, /^https?:\/\//);
  assert.match(config.hlWsUrl, /^wss?:\/\//);
  assert.equal(typeof config.snapshotMinIntervalMs, 'number');
});

test('config has alert defaults', () => {
  assert.equal(config.alertCooldownMs, 900000);
  assert.equal(config.alertPollIntervalMs, 300000);
  assert.equal(config.alertDebounceMs, 5000);
  assert.equal(config.smtpPort, 587);
  assert.match(config.dashboardUrl, /^https?:\/\//);
  // The link in an alert email must point at the port the server actually listens on.
  assert.ok(config.dashboardUrl.endsWith(String(config.port)));
});
