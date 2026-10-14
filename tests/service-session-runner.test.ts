import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runClaimedRun } from '../src/service/session-runner';
import { CheckpointCache } from '../src/service/checkpoint';
import { ClaimedRun } from '../src/service/types';
import { AgentPackage } from '../src/service/agent-package';
import { ModelClient, ModelRunRequest, ModelRunResult } from '../src/service/model-client';
import { PlatformClient } from '../src/service/platform-client';

const baseRun: ClaimedRun = {
  run_id: 'run_t1',
  session_id: 'sess_t1',
  definition_rev: 1,
  threshold_seconds: 60,
  input: { text: 'hi there' },
  service_token: 'st1.abc.def',
};

const pkg: AgentPackage = {
  slug: 'mini',
  name: 'Mini',
  systemPrompt: 'system-prompt',
  model: { primary: { provider: 'anthropic', model: 'm1' }, fallbacks: [] },
  behavior: { asyncThresholdSeconds: 60, maxRunSeconds: 600 },
  skills: [],
  knowledge: { files: [] },
};

interface RecordedCall {
  kind: 'event' | 'checkpoint' | 'complete' | 'fail';
  args: unknown[];
}

function fakePlatform(record: RecordedCall[]) {
  const platform = {
    async appendEvent(runId: string, type: string, payload: unknown) {
      record.push({ kind: 'event', args: [runId, type, payload] });
      return record.length;
    },
    async saveCheckpoint(runId: string, revision: number, snapshot: unknown) {
      record.push({ kind: 'checkpoint', args: [runId, revision, snapshot] });
    },
    async completeRun(runId: string, resultId: string, result: unknown) {
      record.push({ kind: 'complete', args: [runId, resultId, result] });
    },
    async failRun(runId: string, errorText: string, retryable: boolean) {
      record.push({ kind: 'fail', args: [runId, errorText, retryable] });
    },
  };
  return platform as unknown as PlatformClient;
}

function scriptedModel(
  script: (req: ModelRunRequest) => Promise<ModelRunResult> | ModelRunResult,
): { model: ModelClient; calls: ModelRunRequest[] } {
  const calls: ModelRunRequest[] = [];
  const model: ModelClient = {
    async run(req) {
      calls.push(req);
      return script(req);
    },
  };
  return { model, calls };
}

test('fresh run completes with checkpoint revision 1 and ordered writes', async () => {
  const record: RecordedCall[] = [];
  const platform = fakePlatform(record);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-ckpt-'));
  const { model, calls } = scriptedModel((req) => {
    req.onText?.('he');
    req.onText?.('llo');
    return { text: 'hello-1', usage: { promptTokens: 1, completionTokens: 2 } };
  });

  const outcome = await runClaimedRun(baseRun, pkg, model, platform, {
    progressThrottleMs: 0,
    checkpointCache: new CheckpointCache(cacheDir),
  });

  assert.equal(outcome, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serviceToken, 'st1.abc.def');
  assert.deepEqual(calls[0].messages.map((m) => [m.role, m.content]), [['user', 'hi there']]);
  assert.deepEqual(calls[0].models, ['m1']);

  const kinds = record.map((r) => r.kind);
  assert.equal(kinds[0], 'event');
  assert.equal(record[0].args[1], 'progress');
  const eventTypes = record.filter((r) => r.kind === 'event').map((r) => r.args[1]);
  assert.equal(eventTypes[0], 'progress');
  assert.equal(eventTypes[eventTypes.length - 1], 'result');

  // 顺序：saveCheckpoint → result 事件 → complete（先事件后 complete）
  const checkpointIdx = kinds.indexOf('checkpoint');
  const resultIdx = kinds.lastIndexOf('event');
  const completeIdx = kinds.indexOf('complete');
  assert.ok(checkpointIdx > -1 && checkpointIdx < resultIdx && resultIdx < completeIdx, `bad order: ${kinds}`);

  const [ckRunId, revision, snapshot] = record[checkpointIdx].args as [string, number, unknown];
  assert.equal(ckRunId, 'run_t1');
  assert.equal(revision, 1);
  assert.deepEqual(snapshot, {
    v: 1,
    revision: 1,
    history: [
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello-1' },
    ],
  });

  const [, resultId, envelope] = record[completeIdx].args as [string, string, Record<string, unknown>];
  assert.equal(resultId, 'res_run_t1');
  assert.equal(envelope.status, 'completed');
  assert.equal(envelope.contract_version, 'catsco.service-run-result.v1');
  assert.deepEqual(envelope.output, { text: 'hello-1' });
  assert.deepEqual(envelope.usage, { prompt_tokens: 1, completion_tokens: 2 });

  const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, 'sess_t1.json'), 'utf8'));
  assert.equal(cached.revision, 1);
});

test('resume keeps history and does not restart', async () => {
  const record: RecordedCall[] = [];
  const platform = fakePlatform(record);
  const run: ClaimedRun = {
    ...baseRun,
    run_id: 'run_t2',
    checkpoint: {
      revision: 3,
      snapshot: {
        v: 1,
        revision: 3,
        history: [
          { role: 'user', content: 'in1' },
          { role: 'assistant', content: 'out1' },
        ],
      },
    },
  };
  const { model, calls } = scriptedModel(() => ({ text: 'out2', usage: { promptTokens: 2, completionTokens: 3 } }));

  const outcome = await runClaimedRun(run, pkg, model, platform, { progressThrottleMs: 0 });
  assert.equal(outcome, 'completed');
  // 不重头：历史 2 条 + 本轮 user = 3 条，且包含 out1
  assert.deepEqual(
    calls[0].messages.map((m) => [m.role, m.content]),
    [
      ['user', 'in1'],
      ['assistant', 'out1'],
      ['user', 'hi there'],
    ],
  );
  const checkpoint = record.find((r) => r.kind === 'checkpoint');
  assert.ok(checkpoint);
  assert.equal(checkpoint.args[1], 4);
  assert.deepEqual((checkpoint.args[2] as { history: unknown[] }).history.slice(0, 2), [
    { role: 'user', content: 'in1' },
    { role: 'assistant', content: 'out1' },
  ]);
});

test('abort saves checkpoint and abandons without complete', async () => {
  const record: RecordedCall[] = [];
  const platform = fakePlatform(record);
  const controller = new AbortController();
  const { model } = scriptedModel(
    (req) =>
      new Promise<ModelRunResult>((_, reject) => {
        req.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );

  const pending = runClaimedRun(baseRun, pkg, model, platform, {
    signal: controller.signal,
    progressThrottleMs: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const outcome = await pending;

  assert.equal(outcome, 'abandoned');
  assert.equal(record.filter((r) => r.kind === 'complete').length, 0);
  assert.equal(record.filter((r) => r.kind === 'fail').length, 0);
  const checkpoint = record.find((r) => r.kind === 'checkpoint');
  assert.ok(checkpoint, 'abandon must persist a checkpoint');
  // 快照只含「已完成轮」：本轮 user 不落盘（接管时重跑该轮，绝不重头）
  assert.deepEqual((checkpoint.args[2] as { history: unknown[] }).history, []);
  assert.equal(checkpoint.args[1], 1);
});
