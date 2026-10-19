import { AgentPackage, renderKnowledgeBlock } from './agent-package';
import { CheckpointCache, ServiceCheckpoint, buildNextCheckpoint, parseCheckpointSnapshot } from './checkpoint';
import { ModelClient, ServiceChatMessage } from './model-client';
import { PlatformClient } from './platform-client';
import { SERVICE_SKILL_TOOL, SERVICE_SKILL_TOOL_NAME, executeSkillTool, renderSkillsManifest } from './skill-tool';
import { SERVICE_ASK_TOOL, SERVICE_ASK_TOOL_NAME, extractAskQuestion } from './ask-tool';
import { ClaimedRun, ServiceRunResult } from './types';
import { Message } from '../types';
import { ToolDefinition } from '../types/tool';

/**
 * 会话运行器（计划② Task 5）：跑一轮 claim 到的 run。
 * 语义：
 * - history = checkpoint.history（无则空）；本轮输入作为 user 消息追加——绝不重头。
 * - 事件：progress(start) →（delta 节流 progress(delta)）→ result(envelope)。
 * - 完成：saveCheckpoint（revision=prev+1，含本轮 user+assistant）→ result 事件 → complete（先事件后 complete）。
 * - 返问（阶段 2）：模型调用 ask_user → 同一收尾顺序但状态=awaiting_input（问题进
 *   output.question），经 await-input 端点终结并触发平台回注（设计 §3.3-8）；
 *   调用方补充 = 同一会话的下一次 tools/call。
 * - abort / 失败：保存「已完成轮」快照（不含本轮）后返回 abandoned——不 complete / 不 fail，
 *   由租约过期触发接管重跑该轮（attempts 上限由平台 reaper 兜底）。
 */

export interface RunClaimedRunOptions {
  signal?: AbortSignal;
  /** delta 进展事件节流（默认 500ms；0=每条立即上报，测试用）。 */
  progressThrottleMs?: number;
  /** 本地缓存（可选；权威快照在平台侧）。 */
  checkpointCache?: CheckpointCache;
  /** codex 执行后端配置（仅 runner.type=codex 的包需要）。 */
  codex?: import('./codex-runner').CodexExecEnv;
  /** 成功收尾（completed 或 awaiting_input）的计量回调（daemon 汇总指标用）。 */
  onCompleted?: (info: {
    usage: { promptTokens: number; completionTokens: number };
    resumed: boolean;
  }) => void;
}

export type RunOutcome = 'completed' | 'abandoned' | 'awaiting_input';

/** 工具循环上限（防跑飞；超限且有文本则收尾，否则失败重派）。 */
export const TOOL_LOOP_MAX_ROUNDS = 6;

/** 纯函数：把 run 输入转成模型可读文本（优先常见文本字段，否则 JSON）。 */
export function extractUserText(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input && typeof input === 'object') {
    const raw = input as Record<string, unknown>;
    for (const key of ['text', 'prompt', 'content', 'input', 'q']) {
      const candidate = raw[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(input ?? '');
}

export async function runClaimedRun(
  run: ClaimedRun,
  pkg: AgentPackage,
  model: ModelClient,
  platform: PlatformClient,
  opts: RunClaimedRunOptions = {},
): Promise<RunOutcome> {
  // 执行后端分流：声明 runner.type=codex 的包交本机 codex CLI（自含模型/工具循环）。
  if (pkg.runner?.type === 'codex') {
    const { runCodexClaimedRun } = await import('./codex-runner');
    return runCodexClaimedRun(run, pkg, platform, opts);
  }
  const throttleMs = opts.progressThrottleMs ?? 500;
  const previous = parseCheckpointSnapshot(run.checkpoint?.snapshot) ?? undefined;
  const completedHistory: ServiceChatMessage[] = [...(previous?.history ?? [])];
  const userText = extractUserText(run.input);
  const resumed = Boolean(previous && previous.history.length > 0);

  await platform.appendEvent(run.run_id, 'progress', {
    phase: 'start',
    resumed,
  });

  let lastDeltaSentAt = 0;
  const onText = (delta: string): void => {
    if (!delta) {
      return;
    }
    const now = Date.now();
    if (throttleMs > 0 && now - lastDeltaSentAt < throttleMs) {
      return;
    }
    lastDeltaSentAt = now;
    void platform.appendEvent(run.run_id, 'progress', { phase: 'delta', text: delta.slice(-200) }).catch(() => {
      // 进展事件失败不阻断主流程
    });
  };

  try {
    const skills = pkg.skills;
    const systemPrompt =
      pkg.systemPrompt + renderKnowledgeBlock(pkg.knowledge.files) + renderSkillsManifest(skills);
    const toolset: ToolDefinition[] = [];
    if (skills.length > 0) {
      toolset.push(SERVICE_SKILL_TOOL);
    }
    if (pkg.behavior.allowAskUser) {
      toolset.push(SERVICE_ASK_TOOL);
    }
    const tools = toolset.length > 0 ? toolset : undefined;
    const knownToolNames = toolset.map((t) => t.name).join(', ') || '无';
    const convo: Message[] = [
      ...completedHistory.map((m): Message => ({ role: m.role, content: m.content })),
      { role: 'user', content: userText },
    ];
    const usageTotal = { promptTokens: 0, completionTokens: 0 };
    let finalText = '';
    for (let round = 1; ; round += 1) {
      const result = await model.run({
        systemPrompt,
        messages: convo,
        models: [pkg.model.primary.model, ...pkg.model.fallbacks.map((b) => b.model)],
        serviceToken: run.service_token,
        reasoningEffort: pkg.model.primary.reasoning_effort,
        tools,
        signal: opts.signal,
        onText,
      });
      usageTotal.promptTokens += result.usage.promptTokens;
      usageTotal.completionTokens += result.usage.completionTokens;

      if (opts.signal?.aborted) {
        await persistAbandonCheckpoint(run, platform, opts, previous, completedHistory);
        return 'abandoned';
      }

      const calls = result.toolCalls ?? [];
      // 返问（设计 §3.3-8）：模型发起 ask_user → 本次 run 以 awaiting_input 收尾。
      const askCall = calls.find((call) => call.function.name === SERVICE_ASK_TOOL_NAME);
      if (askCall) {
        let askInput: unknown = {};
        try {
          askInput = JSON.parse(askCall.function.arguments || '{}');
        } catch {
          askInput = {};
        }
        const question = extractAskQuestion(askInput);
        if (question) {
          void platform
            .appendEvent(run.run_id, 'progress', { phase: 'tool', name: SERVICE_ASK_TOOL_NAME })
            .catch(() => {
              // 进展事件失败不阻断主流程
            });
          return await finishAwaitingInput(run, platform, opts, previous, completedHistory, userText, question, usageTotal, resumed);
        }
        // 空问题：作为工具错误回给模型，让它重试（不终结 run）
        convo.push({ role: 'assistant', content: result.text || null, tool_calls: calls });
        convo.push({
          role: 'tool',
          tool_call_id: askCall.id,
          content: `错误：${SERVICE_ASK_TOOL_NAME} 工具需要非空 question 参数`,
        });
        continue;
      }
      if (calls.length === 0) {
        finalText = result.text;
        break;
      }
      if (round >= TOOL_LOOP_MAX_ROUNDS) {
        // 防跑飞：超限后如本轮还有文本可用则收尾，否则显式失败（abandon→重派/最终 failed）。
        if (result.text.trim()) {
          finalText = result.text;
          break;
        }
        throw new Error(`tool loop exceeded ${TOOL_LOOP_MAX_ROUNDS} rounds`);
      }
      convo.push({ role: 'assistant', content: result.text || null, tool_calls: calls });
      for (const call of calls) {
        let toolResult: string;
        if (call.function.name === SERVICE_SKILL_TOOL_NAME) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            input = {};
          }
          toolResult = executeSkillTool(skills, input);
        } else {
          toolResult = `错误：未知工具 "${call.function.name}"（本运行时提供 ${knownToolNames}）`;
        }
        convo.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
        void platform
          .appendEvent(run.run_id, 'progress', { phase: 'tool', name: call.function.name })
          .catch(() => {
            // 进展事件失败不阻断主流程
          });
      }
    }

    const nextHistory: ServiceChatMessage[] = [
      ...completedHistory,
      { role: 'user', content: userText },
      { role: 'assistant', content: finalText },
    ];
    const checkpoint = buildNextCheckpoint(previous, nextHistory);
    await platform.saveCheckpoint(run.run_id, checkpoint.revision, checkpoint);
    await opts.checkpointCache?.save(run.session_id, checkpoint);

    const envelope: ServiceRunResult = {
      contract_version: 'catsco.service-run-result.v1',
      run_id: run.run_id,
      session_id: run.session_id,
      status: 'completed',
      output: { text: finalText },
      usage: {
        prompt_tokens: usageTotal.promptTokens,
        completion_tokens: usageTotal.completionTokens,
      },
    };
    await platform.appendEvent(run.run_id, 'result', envelope);
    await platform.completeRun(run.run_id, `res_${run.run_id}`, envelope);
    opts.onCompleted?.({ usage: usageTotal, resumed });
    return 'completed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`service run ${run.run_id} abandoned: ${message}`);
    await persistAbandonCheckpoint(run, platform, opts, previous, completedHistory);
    return 'abandoned';
  }
}

async function persistAbandonCheckpoint(
  run: ClaimedRun,
  platform: PlatformClient,
  opts: RunClaimedRunOptions,
  previous: ServiceCheckpoint | undefined,
  completedHistory: ServiceChatMessage[],
): Promise<void> {
  try {
    const checkpoint = buildNextCheckpoint(previous, completedHistory);
    await platform.saveCheckpoint(run.run_id, checkpoint.revision, checkpoint);
    await opts.checkpointCache?.save(run.session_id, checkpoint);
  } catch (err) {
    console.warn(`service run ${run.run_id} abandon checkpoint failed: ${(err as Error).message}`);
  }
}

/**
 * 返问收尾（设计 §3.3-8）：checkpoint（历史 + 本轮 user + assistant(问题)）→
 * result 事件（status=awaiting_input）→ await-input（平台终结运行并触发回注）。
 * 与 completed 相同的"先事件后终结"顺序；调用方补充 = 同一会话下一次 tools/call。
 */
async function finishAwaitingInput(
  run: ClaimedRun,
  platform: PlatformClient,
  opts: RunClaimedRunOptions,
  previous: ServiceCheckpoint | undefined,
  completedHistory: ServiceChatMessage[],
  userText: string,
  question: string,
  usageTotal: { promptTokens: number; completionTokens: number },
  resumed: boolean,
): Promise<RunOutcome> {
  const nextHistory: ServiceChatMessage[] = [
    ...completedHistory,
    { role: 'user', content: userText },
    { role: 'assistant', content: question },
  ];
  const checkpoint = buildNextCheckpoint(previous, nextHistory);
  await platform.saveCheckpoint(run.run_id, checkpoint.revision, checkpoint);
  await opts.checkpointCache?.save(run.session_id, checkpoint);

  const envelope: ServiceRunResult = {
    contract_version: 'catsco.service-run-result.v1',
    run_id: run.run_id,
    session_id: run.session_id,
    status: 'awaiting_input',
    output: { question },
    usage: {
      prompt_tokens: usageTotal.promptTokens,
      completion_tokens: usageTotal.completionTokens,
    },
  };
  await platform.appendEvent(run.run_id, 'result', envelope);
  await platform.awaitInput(run.run_id, `awt_${run.run_id}`, envelope);
  // 返问为成功收尾：计量照记（daemon 计入 completed；token/耗时真实反映）。
  opts.onCompleted?.({ usage: usageTotal, resumed });
  return 'awaiting_input';
}
