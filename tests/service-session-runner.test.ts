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

// ---- 阶段 2A：prompt 型技能（skill 工具循环）----

const skilledPkg: AgentPackage = {
  ...pkg,
  slug: 'skilled',
  skills: [{ name: 'helper', description: '格式化助手技能', content: '# Helper\n按步骤执行' }],
};

test('skill loop: model loads a skill then completes with merged usage', async () => {
  const record: RecordedCall[] = [];
  const platform = fakePlatform(record);
  const { model, calls } = scriptedModel(() => {
    if (calls.length === 1) {
      return {
        text: '',
        usage: { promptTokens: 2, completionTokens: 3 },
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'skill', arguments: '{"name":"helper"}' } },
        ],
      };
    }
    return { text: 'final-answer', usage: { promptTokens: 4, completionTokens: 5 } };
  });

  const outcome = await runClaimedRun(baseRun, skilledPkg, model, platform, { progressThrottleMs: 0 });
  assert.equal(outcome, 'completed');
  assert.equal(calls.length, 2, 'one tool round + one final round');

  // 第一轮带工具 + 技能清单在 system prompt
  assert.ok(calls[0].tools && calls[0].tools.length === 1 && calls[0].tools[0].name === 'skill');
  assert.ok(calls[0].systemPrompt.includes('## 可用技能'));
  assert.ok(calls[0].systemPrompt.includes('helper'));

  // 第二轮消息链：assistant(tool_calls) + tool(技能全文)
  const secondMessages = calls[1].messages;
  const assistantMsg = secondMessages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistantMsg, 'assistant tool_calls message must be replayed');
  const toolMsg = secondMessages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result message must be appended');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.ok(String(toolMsg.content).includes('[skill:helper]'));

  // 完成：文本=最终轮；usage=多轮累计；checkpoint 只含 user+assistant 文本对
  const complete = record.find((r) => r.kind === 'complete');
  assert.ok(complete);
  const envelope = complete.args[2] as { output: { text: string }; usage: { prompt_tokens: number } };
  assert.equal(envelope.output.text, 'final-answer');
  assert.equal(envelope.usage.prompt_tokens, 6);
  const checkpoint = record.find((r) => r.kind === 'checkpoint');
  assert.ok(checkpoint);
  const history = (checkpoint.args[2] as { history: { role: string; content: string }[] }).history;
  assert.equal(history.length, 2);
  assert.equal(history[1].content, 'final-answer');
  // 工具进展事件
  assert.ok(record.some((r) => r.kind === 'event' && r.args[1] === 'progress' && (r.args[2] as { phase?: string }).phase === 'tool'));
});

test('skill loop: unknown tool name yields an error tool result but continues', async () => {
  const record: RecordedCall[] = [];
  const platform = fakePlatform(record);
  const { model, calls } = scriptedModel((req) => {
    if (calls.length === 1) {
      return {
        text: '',
        usage: { promptTokens: 1, completionTokens: 1 },
        toolCalls: [
          { id: 'call_x', type: 'function', function: { name: 'ghost_tool', arguments: '{}' } },
        ],
      };
    }
    return { text: 'done', usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const outcome = await runClaimedRun(baseRun, skilledPkg, model, platform, { progressThrottleMs: 0 });
  assert.equal(outcome, 'completed');
  const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg && String(toolMsg.content).includes('未知工具'));
});

test('skill loop: exceeding max rounds without text abandons', async () => {
  const record: RecordedCall[] = [];
  const platform = fakePlatform(record);
  const { model } = scriptedModel(() => ({
    text: '',
    usage: { promptTokens: 1, completionTokens: 1 },
    toolCalls: [{ id: 'c', type: 'function', function: { name: 'skill', arguments: '{"name":"helper"}' } }],
  }));
  const outcome = await runClaimedRun(baseRun, skilledPkg, model, platform, { progressThrottleMs: 0 });
  assert.equal(outcome, 'abandoned');
  assert.equal(record.filter((r) => r.kind === 'complete').length, 0);
  assert.equal(record.filter((r) => r.kind === 'checkpoint').length, 1);
});
