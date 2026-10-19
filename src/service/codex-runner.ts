/**
 * Codex 执行后端：agent 包声明 `runner.type=codex` 时，run 交由本机官方 codex CLI 执行。
 *
 * 契约（以真机 0.163.x 实测为准）：
 * - `codex exec --json …`：stdout 为 JSONL 事件流（thread.started / turn.started /
 *   item.* / turn.failed / turn.completed），stderr 为日志；退出码 0=成功。
 * - 续聊：thread_id 存 checkpoint（`codex.threadId`），下一轮 `codex exec resume <id>`；
 *   resume 失效（线程文件丢失/换机）→ 回退为新线程 + 历史摘要前缀。
 * - 工作区：每会话独立目录 `<workspaceRoot>/<session_id>`；沙箱 workspace-write。
 * - 出网：经 `proxy` 注入 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY（生产为本地 ssh 隧道→出口代理）。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildNextCheckpoint, parseCheckpointSnapshot, ServiceCheckpoint } from './checkpoint';
import { AgentPackage } from './agent-package';
import { PlatformClient } from './platform-client';
import { ClaimedRun, ServiceRunResult } from './types';
import { extractUserText, RunClaimedRunOptions } from './session-runner';

export interface CodexExecEnv {
  /** 命令本体（默认 'codex'；测试注入 node）。 */
  command: string;
  /** 命令前缀参数（测试用：node <fake-script>）。 */
  commandPrefixArgs?: string[];
  /** CODEX_HOME（认证/配置/会话存储）。 */
  homeDir: string;
  /** 会话工作区根目录（每 session 子目录）。 */
  workspaceRoot: string;
  /** 沙箱档位（默认 workspace-write）。 */
  sandbox?: 'read-only' | 'workspace-write';
  /** 出口代理（注入 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY；空=不注入）。 */
  proxy?: string;
  /** 追加到 codex 命令行的额外参数（prompt 之前）。 */
  extraArgs?: string[];
  /** 注入子进程的额外环境变量（测试/定制）。 */
  env?: Record<string, string>;
  /** 覆盖运行超时（毫秒；默认取包 maxRunSeconds）。 */
  timeoutMsOverride?: number;
}

/** 解析出的 codex JSONL 事件（type 保证为字符串；其余字段按需读取）。 */
export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexRunResult {
  exitCode: number | null;
  threadId?: string;
  finalText: string;
  usage?: { inputTokens: number; outputTokens: number };
  failureMessage?: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  events: CodexEvent[];
}

/** 纯函数：解析一行 JSONL；非对象或缺 type 返回 null（脏行静默跳过）。 */
export function parseCodexEventLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !type) return null;
  return parsed as CodexEvent;
}

/** 纯函数：最后一个完成的 agent_message 文本（无则空串）。 */
export function pickCodexFinalText(events: CodexEvent[]): string {
  let final = '';
  for (const ev of events) {
    if (ev.type !== 'item.completed') continue;
    const item = ev.item as { type?: unknown; text?: unknown } | undefined;
    if (!item || item.type !== 'agent_message') continue;
    if (typeof item.text === 'string' && item.text.trim()) {
      final = item.text;
    }
  }
  return final;
}

export type CodexProgressNote =
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string };

/** 纯函数：事件 → 进度注记（agent_message→delta；命令/文件变更→tool；其余 null）。 */
export function progressNoteForEvent(ev: CodexEvent): CodexProgressNote | null {
  const item = ev.item as
    | { type?: unknown; text?: unknown; command?: unknown; changes?: Array<{ path?: unknown }> }
    | undefined;
  if (!item) return null;
  if (ev.type === 'item.completed' && item.type === 'agent_message') {
    if (typeof item.text === 'string' && item.text.trim()) {
      return { kind: 'delta', text: item.text };
    }
    return null;
  }
  if (ev.type === 'item.started' && item.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    return { kind: 'tool', name: `命令: ${command.slice(0, 80)}` };
  }
  if (ev.type === 'item.completed' && item.type === 'file_change') {
    const paths = Array.isArray(item.changes)
      ? item.changes
          .map((change) => (typeof change?.path === 'string' ? change.path : ''))
          .filter(Boolean)
      : [];
    return { kind: 'tool', name: `文件: ${paths.slice(0, 3).join(', ') || '(未知路径)'}` };
  }
  return null;
}

export interface CodexInvocationOptions {
  mode: 'exec' | 'resume';
  prompt: string;
  threadId?: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write';
  extraArgs?: string[];
}

/** 纯函数：构造 codex 调用（command + argv）。工作目录由 spawn cwd 控制，不用 -C。 */
export function buildCodexInvocation(
  env: Pick<CodexExecEnv, 'command' | 'commandPrefixArgs'>,
  opts: CodexInvocationOptions,
): { command: string; args: string[] } {
  const common = ['--json', '--skip-git-repo-check'];
  if (opts.mode === 'resume') {
    if (!opts.threadId) {
      throw new Error('resume invocation requires threadId');
    }
    // resume 子命令不接受 --sandbox/-C：沙箱用 -c 覆盖（默认 read-only 会拒绝写入）；
    // 工作目录由 spawn cwd 决定（也是 resume 会话发现的过滤条件）。
    const sandbox = opts.sandbox ?? 'workspace-write';
    return {
      command: env.command,
      args: [
        'exec',
        'resume',
        ...common,
        '-c',
        `sandbox_mode=${sandbox}`,
        ...(opts.extraArgs ?? []),
        opts.threadId,
        opts.prompt,
      ],
    };
  }
  const sandbox = opts.sandbox ?? 'workspace-write';
  const args = ['exec', ...common, '--sandbox', sandbox];
  if (opts.model) {
    args.push('-m', opts.model);
  }
  args.push(...(opts.extraArgs ?? []), opts.prompt);
  return { command: env.command, args };
}

export interface RunCodexOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (ev: CodexEvent) => void;
}

const STDERR_TAIL_LIMIT = 4000;
const KILL_GRACE_MS = 5000;

/** 运行 codex 子进程并解析 JSONL 事件流（脏行跳过；超时/中止均 SIGTERM→宽限后 SIGKILL）。 */
export function runCodex(opts: RunCodexOptions): Promise<CodexRunResult> {
  return new Promise((resolve) => {
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...opts.env })) {
      if (typeof value === 'string') mergedEnv[key] = value;
    }
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const events: CodexEvent[] = [];
    let stdoutBuffer = '';
    let stderrTail = '';
    let threadId: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let failureMessage: string | undefined;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killWithGrace = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出
      }
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
      }, KILL_GRACE_MS);
      hardKill.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killWithGrace();
    }, Math.max(1, opts.timeoutMs));
    timeoutTimer.unref?.();

    const onAbort = (): void => {
      aborted = true;
      killWithGrace();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const handleLine = (line: string): void => {
      const ev = parseCodexEventLine(line);
      if (!ev) return;
      events.push(ev);
      if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && ev.thread_id) {
        threadId = ev.thread_id;
      }
      if (ev.type === 'turn.completed') {
        const rawUsage = ev.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
        usage = {
          inputTokens: typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : 0,
          outputTokens: typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : 0,
        };
      }
      if (ev.type === 'turn.failed') {
        const error = ev.error as { message?: unknown } | undefined;
        failureMessage = typeof error?.message === 'string' ? error.message : 'turn failed';
      }
      try {
        opts.onEvent?.(ev);
      } catch {
        // 进度回调异常不影响执行
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (!failureMessage && exitCode !== 0 && !timedOut && !aborted) {
        const stderrBottom = stderrTail.trim().split('\n').slice(-3).join(' | ');
        failureMessage = stderrBottom
          ? `codex 退出码 ${exitCode}: ${stderrBottom.slice(0, 300)}`
          : `codex 退出码 ${exitCode}`;
      }
      resolve({
        exitCode,
        ...(threadId ? { threadId } : {}),
        finalText: pickCodexFinalText(events),
        ...(usage ? { usage } : {}),
        ...(failureMessage ? { failureMessage } : {}),
        stderrTail,
        timedOut,
        aborted,
        events,
      });
    };

    child.on('error', (error: Error) => {
      failureMessage = `无法启动 codex（${opts.command}）: ${error.message}`;
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}

/** 组装 spawn 环境（CODEX_HOME + 可选代理三件套 + 定制 env）。 */
export function buildCodexProcessEnv(codex: CodexExecEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    CODEX_HOME: codex.homeDir,
    ...(codex.env ?? {}),
  };
  if (codex.proxy) {
    env.HTTPS_PROXY = codex.proxy;
    env.HTTP_PROXY = codex.proxy;
    env.ALL_PROXY = codex.proxy;
    env.NO_PROXY = 'localhost,127.0.0.1';
  }
  return env;
}

/** 历史摘要前缀（resume 失效回退用）：最近 10 条消息。 */
export function buildHistoryRecap(
  history: Array<{ role: string; content: string }>,
): string {
  const recent = history.slice(-10);
  if (recent.length === 0) return '';
  const lines = recent.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`);
  return `以下是此前对话历史（供延续上下文）：\n${lines.join('\n')}\n\n当前请求：\n`;
}

async function persistAbandonCheckpoint(
  run: ClaimedRun,
  platform: PlatformClient,
  opts: RunClaimedRunOptions,
  previous: ServiceCheckpoint | undefined,
  completedHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  try {
    const checkpoint = buildNextCheckpoint(previous, completedHistory, {
      threadId: previous?.codex?.threadId,
    });
    await platform.saveCheckpoint(run.run_id, checkpoint.revision, checkpoint);
    await opts.checkpointCache?.save(run.session_id, checkpoint);
  } catch (err) {
    console.warn(`service run ${run.run_id} abandon checkpoint failed: ${(err as Error).message}`);
  }
}

/**
 * codex 执行后端的一轮 run（session-runner 的 codex 分支）：
 * 工作区 →（resume|exec）→ JSONL 进度 → checkpoint(codex.threadId) → result/complete。
 * 失败/超时/中止 → abandoned（由平台租约接管，语义与文本执行器一致）。
 */
export async function runCodexClaimedRun(
  run: ClaimedRun,
  pkg: AgentPackage,
  platform: PlatformClient,
  opts: RunClaimedRunOptions & { codex?: CodexExecEnv },
): Promise<'completed' | 'abandoned' | 'awaiting_input'> {
  const codex = opts.codex;
  if (!codex) {
    throw new Error('codex runner requires codex execution config (opts.codex)');
  }
  const previous = parseCheckpointSnapshot(run.checkpoint?.snapshot) ?? undefined;
  const completedHistory = previous?.history ?? [];
  const priorThreadId = previous?.codex?.threadId;
  const userText = extractUserText(run.input);
  const resumed = Boolean(previous && (completedHistory.length > 0 || priorThreadId));

  await platform.appendEvent(run.run_id, 'progress', { phase: 'start', resumed });

  const throttleMs = opts.progressThrottleMs ?? 500;
  let lastDeltaSentAt = 0;
  const noteForEvent = (ev: CodexEvent): void => {
    const note = progressNoteForEvent(ev);
    if (!note) return;
    if (note.kind === 'tool') {
      void platform.appendEvent(run.run_id, 'progress', { phase: 'tool', name: note.name }).catch(() => {});
      return;
    }
    const now = Date.now();
    if (throttleMs > 0 && now - lastDeltaSentAt < throttleMs) return;
    lastDeltaSentAt = now;
    void platform
      .appendEvent(run.run_id, 'progress', { phase: 'delta', text: note.text.slice(-200) })
      .catch(() => {});
  };

  const workspaceDir = path.join(codex.workspaceRoot, run.session_id);
  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch (error) {
    console.warn(`service run ${run.run_id} workspace mkdir failed: ${(error as Error).message}`);
  }
  // 工作区指令（codex 会读 cwd 下的 AGENTS.md）：首次物化包的 system prompt。
  try {
    const agentsFile = path.join(workspaceDir, 'AGENTS.md');
    if (!fs.existsSync(agentsFile) && pkg.systemPrompt.trim()) {
      fs.writeFileSync(agentsFile, `${pkg.systemPrompt.trim()}\n`, 'utf8');
    }
  } catch (error) {
    console.warn(`service run ${run.run_id} AGENTS.md materialize failed: ${(error as Error).message}`);
  }

  const timeoutMs = codex.timeoutMsOverride ?? Math.max(1000, pkg.behavior.maxRunSeconds * 1000);
  const sandbox = pkg.runner?.sandbox ?? codex.sandbox ?? 'workspace-write';
  const model = pkg.runner?.model ?? pkg.model.primary.model;
  const extraArgs = [...(codex.extraArgs ?? []), ...(pkg.runner?.extraArgs ?? [])];
  const processEnv = buildCodexProcessEnv(codex);

  const execOnce = async (mode: 'exec' | 'resume', prompt: string, threadId?: string): Promise<CodexRunResult> => {
    const invocation = buildCodexInvocation(codex, {
      mode,
      prompt,
      ...(threadId ? { threadId } : {}),
      sandbox,
      ...(mode === 'exec' ? { model } : {}),
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
    });
    return runCodex({
      command: invocation.command,
      args: [
        ...(codex.commandPrefixArgs ?? []),
        ...invocation.args,
      ],
      cwd: workspaceDir,
      env: processEnv,
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onEvent: noteForEvent,
    });
  };

  try {
    let result: CodexRunResult;
    if (priorThreadId) {
      result = await execOnce('resume', userText, priorThreadId);
      if (result.aborted || opts.signal?.aborted) {
        await persistAbandonCheckpoint(run, platform, opts, previous, completedHistory);
        return 'abandoned';
      }
      if (result.exitCode !== 0 || !result.finalText.trim()) {
        // resume 失效（线程丢失/换机/损坏）：回退为新线程 + 历史摘要，保证交付。
        console.warn(
          `service run ${run.run_id} codex resume failed (exit=${result.exitCode}), falling back to fresh thread`,
        );
        const recap = buildHistoryRecap(completedHistory);
        result = await execOnce('exec', `${recap}${userText}`);
      }
    } else {
      result = await execOnce('exec', userText);
    }

    if (result.aborted || opts.signal?.aborted) {
      await persistAbandonCheckpoint(run, platform, opts, previous, completedHistory);
      return 'abandoned';
    }
    const finalText = result.finalText.trim();
    if (result.exitCode !== 0 || !finalText) {
      const reason = result.failureMessage || (result.timedOut ? 'codex 运行超时' : 'codex 未产出最终文本');
      console.warn(`service run ${run.run_id} codex failed: ${reason}`);
      await persistAbandonCheckpoint(run, platform, opts, previous, completedHistory);
      return 'abandoned';
    }

    const history = [
      ...completedHistory,
      { role: 'user' as const, content: userText },
      { role: 'assistant' as const, content: finalText },
    ];
    const checkpoint = buildNextCheckpoint(previous, history, {
      threadId: result.threadId ?? priorThreadId,
    });
    await platform.saveCheckpoint(run.run_id, checkpoint.revision, checkpoint);
    await opts.checkpointCache?.save(run.session_id, checkpoint);

    const usage = {
      promptTokens: result.usage?.inputTokens ?? 0,
      completionTokens: result.usage?.outputTokens ?? 0,
    };
    const envelope: ServiceRunResult = {
      contract_version: 'catsco.service-run-result.v1',
      run_id: run.run_id,
      session_id: run.session_id,
      status: 'completed',
      output: { text: finalText },
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
      },
    };
    await platform.appendEvent(run.run_id, 'result', envelope);
    await platform.completeRun(run.run_id, `res_${run.run_id}`, envelope);
    opts.onCompleted?.({ usage, resumed });
    return 'completed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`service run ${run.run_id} abandoned: ${message}`);
    await persistAbandonCheckpoint(run, platform, opts, previous, completedHistory);
    return 'abandoned';
  }
}
