import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCodexInvocation,
  parseCodexEventLine,
  pickCodexFinalText,
  progressNoteForEvent,
  pruneCodexWorkspaces,
  runCodex,
  runCodexClaimedRun,
  CodexExecEnv,
} from '../src/service/codex-runner';
import { CheckpointCache } from '../src/service/checkpoint';
import { ClaimedRun } from '../src/service/types';
import { AgentPackage } from '../src/service/agent-package';
import { PlatformClient } from '../src/service/platform-client';

// ---------- 单元：纯函数 ----------

test('parseCodexEventLine: 合法 JSON 事件通过，坏行/缺 type 返回 null', () => {
  assert.deepEqual(parseCodexEventLine('{"type":"turn.started"}'), { type: 'turn.started' });
  assert.equal(parseCodexEventLine('not json at all'), null);
  assert.equal(parseCodexEventLine('{"no":"type"}'), null);
  assert.equal(parseCodexEventLine(''), null);
  assert.equal(parseCodexEventLine('  '), null);
  // 数字/数组等非对象载荷也要拒绝
  assert.equal(parseCodexEventLine('123'), null);
  assert.equal(parseCodexEventLine('[1,2]'), null);
});

test('pickCodexFinalText: 取最后一个 completed agent_message', () => {
  const events = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.completed', item: { type: 'agent_message', text: '第一段' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'x' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '最终答复' } },
    { type: 'turn.completed', usage: {} },
  ];
  assert.equal(pickCodexFinalText(events), '最终答复');
  assert.equal(pickCodexFinalText([]), '');
  // item.started 的 agent_message（进行中）不算
  assert.equal(
    pickCodexFinalText([{ type: 'item.started', item: { type: 'agent_message', text: '半截' } }]),
    '',
  );
});

test('progressNoteForEvent: agent_message→delta，command/file_change→tool，其余静默', () => {
  assert.deepEqual(
    progressNoteForEvent({ type: 'item.completed', item: { type: 'agent_message', text: '想一下' } }),
    { kind: 'delta', text: '想一下' },
  );
  const toolNote = progressNoteForEvent({
    type: 'item.started',
    item: { type: 'command_execution', command: 'bash -lc echo hi' },
  });
  assert.equal(toolNote?.kind, 'tool');
  assert.match(String(toolNote?.name), /命令/);
  const fileNote = progressNoteForEvent({
    type: 'item.completed',
    item: { type: 'file_change', changes: [{ path: '/ws/a.txt', kind: 'add' }] },
  });
  assert.equal(fileNote?.kind, 'tool');
  assert.match(String(fileNote?.name), /文件/);
  assert.equal(progressNoteForEvent({ type: 'turn.started' }), null);
  assert.equal(progressNoteForEvent({ type: 'item.completed', item: { type: 'reasoning' } }), null);
});

test('pruneCodexWorkspaces: 超 TTL 目录删除、新鲜目录与普通文件保留、TTL<=0 关闭', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prune-'));
  try {
    const oldDir = path.join(root, 'sess_old');
    const freshDir = path.join(root, 'sess_fresh');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'a.txt'), 'x');
    const looseFile = path.join(root, 'notes.txt');
    fs.writeFileSync(looseFile, 'keep');
    const now = Date.now();
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldDir, old, old);

    const ttlMs = 14 * 24 * 60 * 60 * 1000;
    const result = pruneCodexWorkspaces(root, ttlMs, now);
    assert.deepEqual(result.removed, ['sess_old']);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(freshDir), true);
    assert.equal(fs.existsSync(looseFile), true);

    // TTL<=0：关闭（不删）
    const disabled = pruneCodexWorkspaces(root, 0, now);
    assert.deepEqual(disabled.removed, []);
    assert.equal(fs.existsSync(freshDir), true);

    // 根目录不存在：不抛错
    assert.deepEqual(pruneCodexWorkspaces(path.join(root, 'nope'), ttlMs, now).removed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildCodexInvocation: exec 基础形状（json/skip-git/sandbox/model/extraArgs/prompt）', () => {
  const inv = buildCodexInvocation(
    { command: 'codex' },
    { mode: 'exec', prompt: '做个事', model: 'gpt-x', sandbox: 'workspace-write', extraArgs: ['--foo'] },
  );
  assert.equal(inv.command, 'codex');
  assert.deepEqual(inv.args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-m',
    'gpt-x',
    '--foo',
    '做个事',
  ]);
});

test('buildCodexInvocation: resume 形状（含 thread id 与 -c 沙箱覆盖，不带 --sandbox/-C）', () => {
  const inv = buildCodexInvocation(
    { command: 'codex' },
    { mode: 'resume', prompt: '继续', threadId: 'th_9', model: 'gpt-x', sandbox: 'workspace-write' },
  );
  assert.deepEqual(inv.args, [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode=workspace-write',
    'th_9',
    '继续',
  ]);
});

// ---------- 集成：伪 codex 进程 ----------

const FAKE_CODEX_SOURCE = String.raw`
const fs = require('fs');
const mode = process.env.FAKE_MODE || 'ok';
const recordFile = process.env.FAKE_RECORD;
const args = process.argv.slice(2);
if (recordFile) {
  fs.appendFileSync(recordFile, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    env: {
      CODEX_HOME: process.env.CODEX_HOME,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
    },
  }) + '\n');
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (mode === 'hang') {
    process.on('SIGTERM', () => process.exit(143));
    await sleep(60000);
    return;
  }
  const isResume = args.includes('resume');
  if (mode === 'resume-fail-then-ok' && isResume) {
    out({ type: 'error', message: 'thread not found' });
    out({ type: 'turn.failed', error: { message: 'session not found: th_prev' } });
    process.exit(1);
  }
  if (mode === 'fail') {
    out({ type: 'thread.started', thread_id: 'th_fail' });
    out({ type: 'turn.started' });
    out({ type: 'error', message: 'simulated failure' });
    out({ type: 'turn.failed', error: { message: 'boom failure' } });
    process.exit(1);
  }
  if (mode === 'crash') {
    process.stderr.write('crash stderr boom\n');
    process.exit(3);
  }
  out({ type: 'thread.started', thread_id: isResume ? args[args.length - 2] : (process.env.FAKE_THREAD_ID || 'th_fixed_1') });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'working on it' } });
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc echo hi', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: isResume ? 'RESUMED-OK' : 'FINAL-OK' } });
  out({ type: 'turn.completed', usage: { input_tokens: 123, cached_input_tokens: 5, output_tokens: 45, reasoning_output_tokens: 7 } });
  process.exit(0);
})();
`;

function writeFakeCodex(root: string): string {
  const file = path.join(root, 'fake-codex.js');
  fs.writeFileSync(file, FAKE_CODEX_SOURCE, 'utf8');
  return file;
}

function makeCodexEnv(root: string, fakeScript: string, overrides: Partial<CodexExecEnv> = {}): CodexExecEnv {
  return {
    command: process.execPath, // node
    commandPrefixArgs: [fakeScript],
    homeDir: path.join(root, 'codex-home'),
    workspaceRoot: path.join(root, 'workspaces'),
    sandbox: 'workspace-write',
    proxy: 'http://127.0.0.1:18899',
    ...overrides,
  };
}

/** 直连 runCodex 的测试参数（与编排层一致：前缀参数 + 调用参数）。 */
function spawnArgsFor(env: CodexExecEnv, args: string[]): string[] {
  return [...(env.commandPrefixArgs ?? []), ...args];
}

function makePkg(overrides: Partial<AgentPackage> = {}): AgentPackage {
  return {
    slug: 'codex',
    name: 'Codex',
    systemPrompt: 'unused-for-codex-runner',
    model: { primary: { provider: 'openai', model: 'gpt-x' }, fallbacks: [] },
    behavior: { asyncThresholdSeconds: 60, maxRunSeconds: 600 },
    runner: { type: 'codex' },
    skills: [],
    knowledge: { files: [] },
    ...overrides,
  };
}

function makeRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    run_id: 'run_cd1',
    session_id: 'sess_cd1',
    definition_rev: 1,
    threshold_seconds: 60,
    input: { text: '把这件事做了' },
    service_token: 'st1.abc.def',
    ...overrides,
  };
}

interface RecordedCall {
  kind: 'event' | 'checkpoint' | 'complete' | 'fail' | 'await';
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
    async awaitInput(runId: string, resultId: string, result: unknown) {
      record.push({ kind: 'await', args: [runId, resultId, result] });
    },
    async failRun(runId: string, errorText: string, retryable: boolean) {
      record.push({ kind: 'fail', args: [runId, errorText, retryable] });
    },
  };
  return platform as unknown as PlatformClient;
}

test('runCodex 集成：ok 路径解析事件流、捕获 threadId/usage/finalText、注入 env/cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  try {
    const fake = writeFakeCodex(root);
    const recordFile = path.join(root, 'record.jsonl');
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const env = makeCodexEnv(root, fake);
    const inv = buildCodexInvocation(env, { mode: 'exec', prompt: '做个事', sandbox: env.sandbox });

    const events: string[] = [];
    const result = await runCodex({
      command: inv.command,
      args: spawnArgsFor(env, inv.args),
      cwd: workspace,
      env: {
        CODEX_HOME: env.homeDir,
        HTTPS_PROXY: env.proxy,
        HTTP_PROXY: env.proxy,
        ALL_PROXY: env.proxy,
        FAKE_MODE: 'ok',
        FAKE_RECORD: recordFile,
      },
      timeoutMs: 30000,
      onEvent: (ev) => events.push(String(ev.type)),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.threadId, 'th_fixed_1');
    assert.equal(result.finalText, 'FINAL-OK');
    assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 });
    assert.ok(events.includes('turn.completed'));

    const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8').trim().split('\n')[0]);
    assert.equal(recorded.cwd, workspace);
    assert.equal(recorded.env.CODEX_HOME, env.homeDir);
    assert.equal(recorded.env.HTTPS_PROXY, env.proxy);
    assert.ok(recorded.argv.includes('--json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodex 集成：失败退出码与 stderr 尾部', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  try {
    const fake = writeFakeCodex(root);
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const env = makeCodexEnv(root, fake);
    const inv = buildCodexInvocation(env, { mode: 'exec', prompt: 'x' });
    const result = await runCodex({
      command: inv.command,
      args: spawnArgsFor(env, inv.args),
      cwd: workspace,
      env: { FAKE_MODE: 'fail' },
      timeoutMs: 30000,
    });
    assert.equal(result.exitCode, 1);
    assert.match(String(result.failureMessage), /boom failure/);
    assert.equal(result.finalText, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodex 集成：超时 SIGTERM 终止，timedOut 标记', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  try {
    const fake = writeFakeCodex(root);
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const env = makeCodexEnv(root, fake);
    const inv = buildCodexInvocation(env, { mode: 'exec', prompt: 'x' });
    const started = Date.now();
    const result = await runCodex({
      command: inv.command,
      args: spawnArgsFor(env, inv.args),
      cwd: workspace,
      env: { FAKE_MODE: 'hang' },
      timeoutMs: 800,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 8000, `应为被及时终止（实测 ${elapsed}ms）`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodex 集成：abort 信号终止进程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  try {
    const fake = writeFakeCodex(root);
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const env = makeCodexEnv(root, fake);
    const inv = buildCodexInvocation(env, { mode: 'exec', prompt: 'x' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await runCodex({
      command: inv.command,
      args: spawnArgsFor(env, inv.args),
      cwd: workspace,
      env: { FAKE_MODE: 'hang' },
      timeoutMs: 60000,
      signal: controller.signal,
    });
    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started < 8000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 编排：runCodexClaimedRun ----------

test('runCodexClaimedRun 全新轮：工作区/env/进度/checkpoint(codex.threadId)/result/complete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const recordFile = path.join(root, 'record.jsonl');
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);
    const run = makeRun();

    const outcome = await runCodexClaimedRun(run, makePkg(), platform, {
      codex: { ...env, env: { FAKE_MODE: 'ok', FAKE_RECORD: recordFile } },
      progressThrottleMs: 0,
      checkpointCache: new CheckpointCache(path.join(root, 'cache')),
    });

    assert.equal(outcome, 'completed');
    const kinds = record.map((r) => r.kind);
    const checkpointIdx = kinds.indexOf('checkpoint');
    const resultIdx = kinds.lastIndexOf('event');
    const completeIdx = kinds.indexOf('complete');
    assert.ok(checkpointIdx > -1 && checkpointIdx < resultIdx && resultIdx < completeIdx, `bad order: ${kinds}`);

    const [, revision, snapshot] = record[checkpointIdx].args as [string, number, Record<string, unknown>];
    assert.equal(revision, 1);
    const snap = snapshot as { history: unknown[]; codex?: { threadId?: string } };
    assert.deepEqual(snap.history, [
      { role: 'user', content: '把这件事做了' },
      { role: 'assistant', content: 'FINAL-OK' },
    ]);
    assert.equal(snap.codex?.threadId, 'th_fixed_1');

    const [, , envelope] = record[completeIdx].args as [string, string, Record<string, unknown>];
    assert.equal((envelope as { status: string }).status, 'completed');
    assert.equal((envelope as { output: { text: string } }).output.text, 'FINAL-OK');
    assert.deepEqual((envelope as { usage: unknown }).usage, { prompt_tokens: 123, completion_tokens: 45 });

    // 进度事件：start + tool（command_execution）+ delta + result
    const phases = record
      .filter((r) => r.kind === 'event')
      .map((r) => (r.args[2] as { phase?: string }).phase)
      .filter(Boolean);
    assert.ok(phases.includes('start'), `phases=${phases}`);
    assert.ok(phases.includes('tool'), `phases=${phases}`);
    assert.ok(phases.includes('delta'), `phases=${phases}`);

    // 工作区按 session 派生且 spawn cwd 正确；AGENTS.md 已物化（首轮）
    const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8').trim().split('\n')[0]);
    assert.equal(recorded.cwd, path.join(env.workspaceRoot, 'sess_cd1'));
    assert.equal(recorded.env.HTTPS_PROXY, env.proxy);
    assert.ok(recorded.argv.includes('exec'));
    assert.ok(!recorded.argv.includes('resume'));
    // 包未声明 runner.model → 不传 -m（用 codex config.toml 默认模型），绝不回落平台模型名
    assert.ok(!recorded.argv.includes('-m'), `argv=${recorded.argv}`);
    assert.ok(!recorded.argv.includes('gpt-x'), `argv=${recorded.argv}`);
    const agentsFile = path.join(env.workspaceRoot, 'sess_cd1', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsFile), 'AGENTS.md 应在首轮物化');
    assert.ok(fs.readFileSync(agentsFile, 'utf8').includes('unused-for-codex-runner'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexClaimedRun 显式 runner.model：-m 覆盖生效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const recordFile = path.join(root, 'record.jsonl');
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);

    const outcome = await runCodexClaimedRun(
      makeRun({ run_id: 'run_model1', session_id: 'sess_model1' }),
      makePkg({ runner: { type: 'codex', model: 'gpt-5.6-sol' } }),
      platform,
      {
        codex: { ...env, env: { FAKE_MODE: 'ok', FAKE_RECORD: recordFile } },
        progressThrottleMs: 0,
      },
    );

    assert.equal(outcome, 'completed');
    const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8').trim().split('\n')[0]);
    const idx = recorded.argv.indexOf('-m');
    assert.ok(idx >= 0, `argv=${recorded.argv}`);
    assert.equal(recorded.argv[idx + 1], 'gpt-5.6-sol');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexClaimedRun 续聊：checkpoint 里有 threadId → resume 调用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const recordFile = path.join(root, 'record.jsonl');
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);
    const run = makeRun({
      checkpoint: {
        revision: 3,
        snapshot: {
          v: 1,
          revision: 3,
          history: [
            { role: 'user', content: '第一轮' },
            { role: 'assistant', content: '第一轮结果' },
          ],
          codex: { threadId: 'th_prev' },
        },
      },
    });

    const outcome = await runCodexClaimedRun(run, makePkg(), platform, {
      codex: { ...env, env: { FAKE_MODE: 'ok', FAKE_RECORD: recordFile } },
      progressThrottleMs: 0,
    });

    assert.equal(outcome, 'completed');
    const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8').trim().split('\n')[0]);
    assert.ok(recorded.argv.includes('resume'), `argv=${recorded.argv}`);
    assert.ok(recorded.argv.includes('th_prev'));

    const [, revision, snapshot] = record.find((r) => r.kind === 'checkpoint')!.args as [
      string,
      number,
      Record<string, unknown>,
    ];
    assert.equal(revision, 4);
    const snap = snapshot as { codex?: { threadId?: string }; history: unknown[] };
    assert.equal(snap.codex?.threadId, 'th_prev');
    assert.equal(snap.history.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexClaimedRun 续聊失效回退：resume 失败 → 带历史摘要重跑新线程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const recordFile = path.join(root, 'record.jsonl');
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);
    const run = makeRun({
      checkpoint: {
        revision: 1,
        snapshot: {
          v: 1,
          revision: 1,
          history: [
            { role: 'user', content: '上一轮问句' },
            { role: 'assistant', content: '上一轮答复' },
          ],
          codex: { threadId: 'th_prev' },
        },
      },
    });

    const outcome = await runCodexClaimedRun(run, makePkg(), platform, {
      codex: { ...env, env: { FAKE_MODE: 'resume-fail-then-ok', FAKE_RECORD: recordFile } },
      progressThrottleMs: 0,
    });

    assert.equal(outcome, 'completed');
    const lines = fs
      .readFileSync(recordFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, '应先 resume 失败再回退');
    assert.ok(lines[0].argv.includes('resume'));
    assert.ok(!lines[1].argv.includes('resume'));
    const fallbackPrompt = String(lines[1].argv[lines[1].argv.length - 1]);
    assert.match(fallbackPrompt, /对话历史/);
    assert.match(fallbackPrompt, /上一轮答复/);
    assert.match(fallbackPrompt, /把这件事做了/);

    const [, , snapshot] = record.find((r) => r.kind === 'checkpoint')!.args as [string, number, Record<string, unknown>];
    assert.equal((snapshot as { codex?: { threadId?: string } }).codex?.threadId, 'th_fixed_1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexClaimedRun 失败：退出非零 → abandoned（abandon checkpoint，无 result/complete）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);
    const outcome = await runCodexClaimedRun(makeRun(), makePkg(), platform, {
      codex: { ...env, env: { FAKE_MODE: 'fail' } },
      progressThrottleMs: 0,
    });
    assert.equal(outcome, 'abandoned');
    const kinds = record.map((r) => r.kind);
    assert.ok(kinds.includes('checkpoint'), 'abandon 也要保存已完成轮快照');
    assert.ok(!kinds.includes('complete'));
    assert.ok(!kinds.includes('await'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexClaimedRun 超时：进程被杀 → abandoned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);
    const started = Date.now();
    const outcome = await runCodexClaimedRun(makeRun(), makePkg({ behavior: { asyncThresholdSeconds: 60, maxRunSeconds: 1 } }), platform, {
      codex: { ...env, env: { FAKE_MODE: 'hang' } },
      progressThrottleMs: 0,
    });
    assert.equal(outcome, 'abandoned');
    assert.ok(Date.now() - started < 10000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexClaimedRun abort：外部信号 → abandoned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claimed-'));
  try {
    const fake = writeFakeCodex(root);
    const env = makeCodexEnv(root, fake);
    const record: RecordedCall[] = [];
    const platform = fakePlatform(record);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const outcome = await runCodexClaimedRun(makeRun(), makePkg(), platform, {
      codex: { ...env, env: { FAKE_MODE: 'hang' } },
      signal: controller.signal,
      progressThrottleMs: 0,
    });
    assert.equal(outcome, 'abandoned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
