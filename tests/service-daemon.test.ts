import { test } from 'node:test';
import * as assert from 'node:assert';
import { ServiceDaemon } from '../src/service/daemon';
import { loadServiceConfig } from '../src/service/config';
import { AgentPackage } from '../src/service/agent-package';
import { ModelClient, ModelRunResult } from '../src/service/model-client';
import { PlatformClient } from '../src/service/platform-client';
import { ClaimedRun } from '../src/service/types';

const pkg: AgentPackage = {
  slug: 'mini',
  name: 'Mini',
  systemPrompt: 'sp',
  model: { primary: { provider: 'anthropic', model: 'm1' }, fallbacks: [] },
  behavior: { asyncThresholdSeconds: 60, maxRunSeconds: 600 },
  skills: [],
  knowledge: { files: [] },
};

function makeRun(id: string): ClaimedRun {
  return {
    run_id: id,
    session_id: `sess_${id}`,
    definition_rev: 1,
    threshold_seconds: 60,
    input: { text: id },
    service_token: 'st1.x.y',
  };
}

interface FakePlatformState {
  queue: ClaimedRun[];
  completes: string[];
  checkpoints: string[];
  events: { runId: string; type: string }[];
  runHeartbeats: string[];
  instanceHeartbeats: number;
  claimLimits: number[];
}

function fakePlatform(state: FakePlatformState): PlatformClient {
  return {
    async claim(limit: number) {
      state.claimLimits.push(limit);
      return state.queue.splice(0, limit);
    },
    async heartbeatRun(runId: string) {
      state.runHeartbeats.push(runId);
      return true;
    },
    async appendEvent(runId: string, type: string) {
      state.events.push({ runId, type });
      return state.events.length;
    },
    async saveCheckpoint(runId: string) {
      state.checkpoints.push(runId);
    },
    async completeRun(runId: string) {
      state.completes.push(runId);
    },
    async failRun() {
      /* no-op */
    },
    async heartbeatInstance() {
      state.instanceHeartbeats += 1;
    },
  } as unknown as PlatformClient;
}

function emptyState(queue: ClaimedRun[]): FakePlatformState {
  return {
    queue,
    completes: [],
    checkpoints: [],
    events: [],
    runHeartbeats: [],
    instanceHeartbeats: 0,
    claimLimits: [],
  };
}

function configFor(overrides: Record<string, string>): ReturnType<typeof loadServiceConfig> {
  return loadServiceConfig({
    CATS_SERVICE_PLATFORM_BASE_URL: 'http://x',
    CATS_SERVICE_INSTANCE_TOKEN: 't',
    ...overrides,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error('waitFor timeout');
}

test('claims up to concurrency and completes runs', async (t) => {
  const state = emptyState([makeRun('r1'), makeRun('r2'), makeRun('r3')]);
  const config = configFor({
    CATS_SERVICE_CONCURRENCY: '2',
    CATS_SERVICE_POLL_INTERVAL_MS: '25',
    CATS_SERVICE_HEARTBEAT_MS: '1000',
    CATS_SERVICE_SHUTDOWN_GRACE_MS: '500',
  });
  const model: ModelClient = {
    async run(req): Promise<ModelRunResult> {
      await sleep(50);
      const last = req.messages[req.messages.length - 1];
      return { text: `out:${last.content}`, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const daemon = new ServiceDaemon({ config, pkg, model, platform: fakePlatform(state) });
  t.after(() => daemon.shutdown());
  const running = daemon.run();

  await waitFor(() => state.completes.length >= 3, 5000);
  await daemon.shutdown();
  await running;

  assert.deepEqual([...state.completes].sort(), ['r1', 'r2', 'r3']);
  // 并发上限=2：领单从不超 2；首选容量=min(2-0,4)=2
  assert.equal(state.claimLimits[0], 2);
  assert.ok(Math.max(...state.claimLimits) <= 2, `claim limits=${state.claimLimits}`);
  assert.ok(state.instanceHeartbeats >= 1, 'instance heartbeat should fire');
  const metrics = daemon.metricsSnapshot();
  assert.equal(metrics.completed, 3);
  assert.equal(metrics.tokens_total, 6);
});

test('renews run lease while running', async (t) => {
  const state = emptyState([makeRun('r1')]);
  const config = configFor({
    CATS_SERVICE_CONCURRENCY: '1',
    CATS_SERVICE_POLL_INTERVAL_MS: '25',
    CATS_SERVICE_HEARTBEAT_MS: '1000',
    CATS_SERVICE_SHUTDOWN_GRACE_MS: '500',
  });
  const model: ModelClient = {
    async run(): Promise<ModelRunResult> {
      await sleep(1600);
      return { text: 'ok', usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const daemon = new ServiceDaemon({ config, pkg, model, platform: fakePlatform(state) });
  t.after(() => daemon.shutdown());
  const running = daemon.run();

  await waitFor(() => state.completes.length === 1, 5000);
  await daemon.shutdown();
  await running;

  const renewals = state.runHeartbeats.filter((id) => id === 'r1').length;
  assert.ok(renewals >= 1, `expected >=1 lease renewal, got ${renewals}`);
});

test('graceful shutdown stops claiming and abandons mid-run', async (t) => {
  const state = emptyState([makeRun('r1')]);
  const config = configFor({
    CATS_SERVICE_CONCURRENCY: '1',
    CATS_SERVICE_POLL_INTERVAL_MS: '25',
    CATS_SERVICE_HEARTBEAT_MS: '1000',
    CATS_SERVICE_SHUTDOWN_GRACE_MS: '0',
  });
  const model: ModelClient = {
    async run(req): Promise<ModelRunResult> {
      return new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  };
  const daemon = new ServiceDaemon({ config, pkg, model, platform: fakePlatform(state) });
  t.after(() => daemon.shutdown());
  const running = daemon.run();

  await waitFor(() => daemon.activeCount === 1, 2000);
  const claimsBefore = state.claimLimits.length;
  await daemon.shutdown();
  await running;

  // 中途放弃：无 complete；保存了 abandon 快照
  assert.equal(state.completes.length, 0);
  assert.equal(state.checkpoints.length, 1);
  // 不再 claim
  await sleep(80);
  assert.equal(state.claimLimits.length, claimsBefore);
  // 指标：abandon 计入 failed
  const metrics = daemon.metricsSnapshot();
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.active_runs, 0);
});
