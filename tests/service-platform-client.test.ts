import { test } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { PlatformClient } from '../src/service/platform-client';
import { loadServiceConfig, ServiceConfig } from '../src/service/config';

const sampleRun = {
  run_id: 'run_1',
  session_id: 'sess_1',
  definition_rev: 1,
  threshold_seconds: 60,
  input: { q: 'hi' },
  service_token: 'st1.abc.def',
  checkpoint: { revision: 3, snapshot: { v: 1, history: [] } },
};

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

interface MockPlatform {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

async function startMockPlatform(opts: { failFirstClaim?: boolean } = {}): Promise<MockPlatform> {
  const requests: RecordedRequest[] = [];
  let claimAttempts = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const path = req.url ?? '';
      if (path === '/internal/service-runs/claim') {
        claimAttempts += 1;
        if (opts.failFirstClaim && claimAttempts === 1) {
          send(500, { error: 'boom' });
          return;
        }
        send(200, { runs: [sampleRun] });
        return;
      }
      if (path.startsWith('/internal/service-instances/') && path.endsWith('/heartbeat')) {
        send(200, { ok: true });
        return;
      }
      if (!path.startsWith('/internal/service-runs/run_1/')) {
        send(404, { error: 'not_found' });
        return;
      }
      if (path.endsWith('/heartbeat')) {
        send(200, { renewed: true });
        return;
      }
      if (path.endsWith('/events')) {
        send(200, { seq: 1 });
        return;
      }
      if (path.endsWith('/checkpoint')) {
        send(200, { saved: true });
        return;
      }
      if (path.endsWith('/complete')) {
        send(200, { completed: true, idempotent: false });
        return;
      }
      if (path.endsWith('/fail')) {
        send(200, { ok: true });
        return;
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // fetch(undici) 默认 keep-alive：须先断开空闲连接，否则 close 回调不触发。
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function cfgFor(baseUrl: string): ServiceConfig {
  return loadServiceConfig({
    CATS_SERVICE_PLATFORM_BASE_URL: baseUrl,
    CATS_SERVICE_INSTANCE_TOKEN: 'inst-token',
    CATS_SERVICE_INSTANCE_ID: 'inst-test',
  });
}

test('claim auth retry and payload against mock platform', async (t) => {
  const server = await startMockPlatform({ failFirstClaim: true });
  t.after(() => server.close());
  const client = new PlatformClient(cfgFor(server.url), { retryDelayMs: 5 });
  const runs = await client.claim(2);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, 'run_1');
  assert.equal(runs[0].service_token.startsWith('st1.'), true);
  assert.equal(runs[0].checkpoint?.revision, 3);

  const claims = server.requests.filter((r) => r.path === '/internal/service-runs/claim');
  assert.equal(claims.length, 2, 'first 500 must be retried once');
  assert.deepEqual(claims[1].body, { limit: 2, instance_id: 'inst-test' });
  for (const request of server.requests) {
    assert.equal(request.auth, 'Bearer inst-token');
  }
});

test('mutations hit right routes and 4xx rejects without retry', async (t) => {
  const server = await startMockPlatform();
  t.after(() => server.close());
  const client = new PlatformClient(cfgFor(server.url), { retryDelayMs: 5 });

  assert.equal(await client.heartbeatRun('run_1'), true);
  assert.equal(await client.appendEvent('run_1', 'progress', { pct: 50 }), 1);
  await client.saveCheckpoint('run_1', 4, { v: 1, history: [] });
  await client.completeRun('run_1', 'res_run_1', {
    contract_version: 'catsco.service-run-result.v1',
    run_id: 'run_1',
    session_id: 'sess_1',
    status: 'completed',
    output: { text: 'ok' },
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  });
  await client.heartbeatInstance(1, {
    active_runs: 1,
    completed: 0,
    failed: 0,
    resumed: 0,
    p95_duration_ms: 0,
    tokens_total: 0,
  });

  const paths = server.requests.map((r) => r.path);
  assert.ok(paths.includes('/internal/service-runs/run_1/heartbeat'));
  assert.ok(paths.includes('/internal/service-runs/run_1/events'));
  assert.ok(paths.includes('/internal/service-runs/run_1/checkpoint'));
  assert.ok(paths.includes('/internal/service-runs/run_1/complete'));
  assert.ok(paths.includes('/internal/service-instances/inst-test/heartbeat'));

  const before = server.requests.length;
  await assert.rejects(client.appendEvent('run_unknown', 'progress', {}), /404/);
  assert.equal(server.requests.length, before + 1, '4xx must not be retried');
});
