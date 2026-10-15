import { test } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ServiceDaemon } from '../src/service/daemon';
import { loadAllAgentPackages } from '../src/service/agent-package';
import { loadServiceConfig, ServiceConfig } from '../src/service/config';
import { RelayModelClient } from '../src/service/model-client';
import { PlatformClient } from '../src/service/platform-client';
import { ClaimedRun } from '../src/service/types';

// ---- 工具 ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

// ---- mock 平台（计划①契约子集：claim/心跳/事件/检查点/完成） ----

interface MockPlatform {
  url: string;
  claimLimits: number[];
  events: { runId: string; type: string; payload: unknown }[];
  checkpoints: { runId: string; revision: number; snapshot: unknown }[];
  completes: { runId: string; resultId: string; result: { output?: { text?: string }; usage?: unknown } }[];
  requeue: (run: ClaimedRun) => void;
  close: () => Promise<void>;
}

async function startMockPlatform(initialRuns: ClaimedRun[]): Promise<MockPlatform> {
  const queue: ClaimedRun[] = [...initialRuns];
  const claimLimits: number[] = [];
  const events: MockPlatform['events'] = [];
  const checkpoints: MockPlatform['checkpoints'] = [];
  const completes: MockPlatform['completes'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '';
      if (url === '/internal/service-runs/claim') {
        const limit = Number(body.limit ?? 0);
        claimLimits.push(limit);
        send(200, { runs: queue.splice(0, limit) });
        return;
      }
      if (url.startsWith('/internal/service-instances/') && url.endsWith('/heartbeat')) {
        send(200, { ok: true });
        return;
      }
      if (url.startsWith('/internal/service-runs/')) {
        const runId = url.split('/')[3] ?? '';
        if (url.endsWith('/events')) {
          events.push({ runId, type: String(body.type ?? ''), payload: body.payload });
          send(200, { seq: events.length });
          return;
        }
        if (url.endsWith('/checkpoint')) {
          checkpoints.push({ runId, revision: Number(body.revision ?? 0), snapshot: body.snapshot });
          send(200, { saved: true });
          return;
        }
        if (url.endsWith('/complete')) {
          completes.push({
            runId,
            resultId: String(body.result_id ?? ''),
            result: (body.result ?? {}) as MockPlatform['completes'][number]['result'],
          });
          send(200, { completed: true, idempotent: false });
          return;
        }
        if (url.endsWith('/heartbeat')) {
          send(200, { renewed: true });
          return;
        }
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    claimLimits,
    events,
    checkpoints,
    completes,
    requeue: (run: ClaimedRun) => {
      queue.push(run);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---- mock relay（anthropic /v1/messages SSE；可挂起在第二段 delta 前） ----

interface MockRelay {
  url: string;
  requests: { path: string; model: string; system?: string; messages: { role: string; content: unknown }[] }[];
  setMode: (mode: 'normal' | 'hang') => void;
  close: () => Promise<void>;
}

async function startMockRelay(): Promise<MockRelay> {
  const requests: MockRelay['requests'] = [];
  let mode: 'normal' | 'hang' = 'normal';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({
        path: req.url ?? '',
        model: String(body.model ?? ''),
        system: typeof body.system === 'string' ? body.system : undefined,
        messages: Array.isArray(body.messages) ? (body.messages as MockRelay['requests'][number]['messages']) : [],
      });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const writeEvent = (type: string, data: unknown) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      writeEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      });
      writeEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      });
      if (mode === 'hang') {
        // 第二段 delta 前挂起：留给 SIGKILL（模拟半途进程死亡）
        return;
      }
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'from relay' },
      });
      writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
      writeEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      writeEvent('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (next) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---- 公共配置 ----

function e2eConfig(platformUrl: string, relayUrl: string, instanceId: string): ServiceConfig {
  return loadServiceConfig({
    CATS_SERVICE_PLATFORM_BASE_URL: platformUrl,
    CATS_SERVICE_INSTANCE_TOKEN: 'inst-token',
    CATS_SERVICE_INSTANCE_ID: instanceId,
    CATS_SERVICE_RELAY_BASE_URL: relayUrl,
    CATS_SERVICE_AGENTS_DIR: path.resolve(__dirname, '..', 'agents'),
    CATS_SERVICE_CONCURRENCY: '1',
    CATS_SERVICE_POLL_INTERVAL_MS: '25',
    CATS_SERVICE_HEARTBEAT_MS: '1000',
    CATS_SERVICE_SHUTDOWN_GRACE_MS: '200',
  });
}

// ---- 场景 A：正常端到端 ----

test('scenario A: daemon completes a run end to end', async (t) => {
  const run: ClaimedRun = {
    run_id: 'run_a1',
    session_id: 'sess_a1',
    agent_slug: 'hello',
    definition_rev: 1,
    threshold_seconds: 60,
    input: { text: 'ping' },
    service_token: 'st1.mock.sig',
  };
  const platform = await startMockPlatform([run]);
  const relay = await startMockRelay();
  t.after(async () => {
    await platform.close();
    await relay.close();
  });

  const config = e2eConfig(platform.url, relay.url, 'inst-e2e');
  const packages = await loadAllAgentPackages(config.agentsDir);
  const daemon = new ServiceDaemon({
    config,
    packages,
    model: new RelayModelClient(config.relayBaseUrl),
    platform: new PlatformClient(config),
  });
  const running = daemon.run();
  await waitFor(() => platform.completes.length === 1, 15_000, 'platform complete');
  await daemon.shutdown();
  await running;

  // relay 真实请求：模型=hello 包绑定、system=包提示词、messages=本轮输入
  assert.equal(relay.requests.length, 1);
  assert.equal(relay.requests[0].path, '/v1/messages');
  assert.equal(relay.requests[0].model, 'MiniMax-M3');
  assert.ok((relay.requests[0].system ?? '').includes('Hello'));
  assert.deepEqual(
    relay.requests[0].messages.map((m) => [m.role, m.content]),
    [['user', 'ping']],
  );

  // 平台：事件序列 progress 开头 result 收尾；checkpoint 与 complete envelope
  const types = platform.events.map((e) => e.type);
  assert.equal(types[0], 'progress');
  assert.equal(types[types.length - 1], 'result');
  assert.equal(platform.checkpoints.length, 1);
  assert.equal(platform.checkpoints[0].revision, 1);
  assert.deepEqual((platform.checkpoints[0].snapshot as { history: unknown[] }).history, [
    { role: 'user', content: 'ping' },
    { role: 'assistant', content: 'Hello from relay' },
  ]);
  const done = platform.completes[0];
  assert.equal(done.resultId, 'res_run_a1');
  assert.equal(done.result.output?.text, 'Hello from relay');
  assert.deepEqual(done.result.usage, { prompt_tokens: 3, completion_tokens: 5 });
  const metrics = daemon.metricsSnapshot();
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.tokens_total, 8);
});

// ---- 场景 B：杀进程 + 携带检查点接管续跑 ----

test('scenario B: kill child daemon then resume from checkpoint without restarting', async (t) => {
  const run: ClaimedRun = {
    run_id: 'run_b1',
    session_id: 'sess_b1',
    agent_slug: 'hello',
    definition_rev: 1,
    threshold_seconds: 60,
    input: { text: 'carry on' },
    service_token: 'st1.mock.sig',
  };
  const platform = await startMockPlatform([run]);
  const relay = await startMockRelay();
  t.after(async () => {
    await platform.close();
    await relay.close();
  });
  relay.setMode('hang');

  // 子进程 daemon：跑到模型（挂起）后 SIGKILL（模拟半途进程死亡、无 checkpoint 落盘）
  const tsxCli = path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, path.resolve(__dirname, 'fixtures', 'service', 'child-daemon.ts')], {
    env: {
      ...process.env,
      CATS_SERVICE_PLATFORM_BASE_URL: platform.url,
      CATS_SERVICE_INSTANCE_TOKEN: 'inst-token',
      CATS_SERVICE_INSTANCE_ID: 'inst-child',
      CATS_SERVICE_RELAY_BASE_URL: relay.url,
      CATS_SERVICE_AGENTS_DIR: path.resolve(__dirname, '..', 'agents'),
      CATS_SERVICE_CONCURRENCY: '1',
      CATS_SERVICE_POLL_INTERVAL_MS: '25',
      CATS_SERVICE_HEARTBEAT_MS: '1000',
      CATS_SERVICE_SHUTDOWN_GRACE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childStderr = '';
  child.stderr?.on('data', (chunk) => (childStderr += String(chunk)));
  const childExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  });

  await waitFor(() => relay.requests.length >= 1, 30_000, `child reaches relay${childStderr ? ` (stderr: ${childStderr})` : ''}`);
  child.kill('SIGKILL');
  await childExit;

  // 模拟 reaper：run 置 orphaned 并提供「第一段历史」检查点
  relay.setMode('normal');
  platform.requeue({
    ...run,
    checkpoint: {
      revision: 2,
      snapshot: {
        v: 1,
        revision: 2,
        history: [
          { role: 'user', content: 'kick' },
          { role: 'assistant', content: 'ACK' },
        ],
      },
    },
  });

  // 新实例接管：不重头（第一段历史原样保留 + 追加本轮输入）
  const config = e2eConfig(platform.url, relay.url, 'inst-resumer');
  const packages = await loadAllAgentPackages(config.agentsDir);
  const daemon = new ServiceDaemon({
    config,
    packages,
    model: new RelayModelClient(config.relayBaseUrl),
    platform: new PlatformClient(config),
  });
  const running = daemon.run();
  await waitFor(() => platform.completes.length === 1, 15_000, 'resumer complete');
  await daemon.shutdown();
  await running;

  assert.equal(relay.requests.length, 2);
  const resumed = relay.requests[1];
  assert.deepEqual(
    resumed.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'kick'],
      ['assistant', 'ACK'],
      ['user', 'carry on'],
    ],
  );
  const metrics = daemon.metricsSnapshot();
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.resumed, 1);
  // 完成的 envelope 正常
  assert.equal(platform.completes[0].resultId, 'res_run_b1');
  assert.equal(platform.completes[0].result.output?.text, 'Hello from relay');
});
