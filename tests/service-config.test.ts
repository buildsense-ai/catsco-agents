import { test } from 'node:test';
import * as assert from 'node:assert';
import { loadServiceConfig } from '../src/service/config';

test('service config defaults and clamps', () => {
  const c = loadServiceConfig({
    CATS_SERVICE_PLATFORM_BASE_URL: 'http://127.0.0.1:26061',
    CATS_SERVICE_INSTANCE_TOKEN: 't',
  });
  assert.equal(c.platformBaseUrl, 'http://127.0.0.1:26061');
  assert.equal(c.instanceToken, 't');
  assert.equal(c.concurrency, 2);
  assert.equal(c.pollIntervalMs, 2000);
  assert.equal(c.heartbeatMs, 10000);
  assert.equal(c.shutdownGraceMs, 30000);
  assert.equal(c.relayBaseUrl, 'http://127.0.0.1:18089');
  assert.equal(c.agentsDir.endsWith('agents'), true);
  assert.ok(c.instanceId.length > 0);
});

test('service config rejects missing required values', () => {
  assert.throws(() => loadServiceConfig({}), /CATS_SERVICE_PLATFORM_BASE_URL/);
  assert.throws(() => loadServiceConfig({ CATS_SERVICE_PLATFORM_BASE_URL: 'http://x' }), /CATS_SERVICE_INSTANCE_TOKEN/);
  assert.throws(() => loadServiceConfig({ CATS_SERVICE_INSTANCE_TOKEN: 't' }), /CATS_SERVICE_PLATFORM_BASE_URL/);
});

test('service config clamps ranges and honors overrides', () => {
  const c = loadServiceConfig({
    CATS_SERVICE_PLATFORM_BASE_URL: 'http://x/',
    CATS_SERVICE_INSTANCE_TOKEN: ' t ',
    CATS_SERVICE_CONCURRENCY: '99',
    CATS_SERVICE_POLL_INTERVAL_MS: '100',
    CATS_SERVICE_RELAY_BASE_URL: 'https://relay.catsco.cc/',
    CATS_SERVICE_INSTANCE_ID: 'inst-a',
  });
  assert.equal(c.platformBaseUrl, 'http://x');
  assert.equal(c.instanceToken, 't');
  assert.equal(c.concurrency, 8);
  assert.equal(c.pollIntervalMs, 250);
  assert.equal(c.relayBaseUrl, 'https://relay.catsco.cc');
  assert.equal(c.instanceId, 'inst-a');

  const low = loadServiceConfig({
    CATS_SERVICE_PLATFORM_BASE_URL: 'http://x',
    CATS_SERVICE_INSTANCE_TOKEN: 't',
    CATS_SERVICE_CONCURRENCY: '0',
    CATS_SERVICE_SHUTDOWN_GRACE_MS: '9999999',
  });
  assert.equal(low.concurrency, 1);
  assert.equal(low.shutdownGraceMs, 120000);
});
