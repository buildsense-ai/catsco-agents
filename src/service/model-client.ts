import { AnthropicProvider } from '../providers/anthropic-provider';
import { ChatConfig, ChatResponse, Message } from '../types';
import { ToolCall, ToolDefinition } from '../types/tool';

/**
 * 模型调用封装（计划② Task 4）。
 * 真实现走 relay 的 anthropic 协议面（POST {relayBaseUrl}/v1/messages 由 provider 构造），
 * apiKey=服务 token（st1.，计费归 caller）；每次 run 新建 provider（token 随 run 变化）。
 * 支持工具（阶段 2A：prompt 型技能经 skill 工具按需加载）——toolCalls 透传给调用方循环。
 * daemon / session-runner 只依赖 ModelClient 接口，测试注入 fake。
 */

/** 服务会话历史消息（checkpoint 快照内使用的稳定形态）。 */
export interface ServiceChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelRunRequest {
  systemPrompt: string;
  messages: Message[];
  /** 应用的模型绑定（主模型在 [0]；回退列表后续使用）。 */
  models: string[];
  serviceToken: string;
  reasoningEffort?: string;
  /** 可用工具（无则不下发）。 */
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface ModelRunResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  stopReason?: string;
  /** 模型请求的工具调用（有则应执行后回灌续跑）。 */
  toolCalls?: ToolCall[];
}

export interface ModelClient {
  run(req: ModelRunRequest): Promise<ModelRunResult>;
}

/** 纯函数：system 提示 + 会话消息 → provider Message[]（system 首条，空提示跳过）。 */
export function buildProviderMessages(systemPrompt: string, messages: Message[]): Message[] {
  const out: Message[] = [];
  const system = systemPrompt.trim();
  if (system) {
    out.push({ role: 'system', content: system });
  }
  out.push(...messages);
  return out;
}

/** 纯函数：ChatResponse → 服务 usage（缺省 0）。 */
export function extractUsage(
  response: ChatResponse | undefined | null,
): { promptTokens: number; completionTokens: number } {
  const usage = response?.usage;
  return {
    promptTokens: Number.isFinite(usage?.promptTokens) ? (usage?.promptTokens as number) : 0,
    completionTokens: Number.isFinite(usage?.completionTokens) ? (usage?.completionTokens as number) : 0,
  };
}

/**
 * 剥离输出开头的推理序言（CoT 泄漏防御，2026-10-19 真机探针发现）。
 * 背景：weekly-report（claude-sonnet-5-5 经 relay）约 1/3 的成品把思考过程
 * 作为正文吐出（"The user has provided… Let me draft…" 后才是报告）。
 *
 * 规则（保守，仅限 service 路径）：
 * - 仅当正文中存在 markdown 标题行（# / ## …）、且标题前的序言带明显推理/过程
 *   特征（英文主导，或"让我分析/用户提供/Let me/The user"类叙述口吻）时剥离；
 * - 无标题、标题已在开头、序言不像推理（如正当的双语铺垫）→ 原样返回。
 * 依据：本平台全部 service agent 的输出规范均要求以 # / ## 标题开头。
 */
export function stripReasoningPreamble(text: string): { text: string; stripped: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { text, stripped: false };
  const lines = trimmed.split('\n');
  const headingIdx = lines.findIndex(line => /^#{1,6}\s/.test(line.trim()));
  if (headingIdx <= 0) return { text, stripped: false };
  const preamble = lines.slice(0, headingIdx).join('\n').trim();
  if (!preamble || !looksLikeReasoningPreamble(preamble)) return { text, stripped: false };
  return { text: lines.slice(headingIdx).join('\n').trim(), stripped: true };
}

function looksLikeReasoningPreamble(preamble: string): boolean {
  const asciiLetters = (preamble.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (preamble.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (asciiLetters > 20 && asciiLetters > cjk) return true;
  return /(Let me|The user|I've|I have|I will|I'll|让我|我来分析|让我先|用户提供|用户想要|分析一下|先分析|我需要先)/i.test(
    preamble,
  );
}

export class RelayModelClient implements ModelClient {
  constructor(private readonly relayBaseUrl: string) {}

  async run(req: ModelRunRequest): Promise<ModelRunResult> {
    if (!req.models.length || !req.models[0]) {
      throw new Error('model binding missing (models is empty)');
    }
    const config: ChatConfig = {
      provider: 'anthropic',
      apiUrl: this.relayBaseUrl,
      apiKey: req.serviceToken,
      model: req.models[0],
    };
    if (req.reasoningEffort) {
      config.reasoningEffort = req.reasoningEffort as ChatConfig['reasoningEffort'];
    }
    const provider = new AnthropicProvider(config);
    let streamed = '';
    const response = await provider.chatStream(
      buildProviderMessages(req.systemPrompt, req.messages),
      req.tools ?? [],
      {
        onText: (delta: string) => {
          streamed += delta;
          req.onText?.(delta);
        },
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    const rawText = (streamed || response?.content || '').trim();
    const sanitized = stripReasoningPreamble(rawText);
    if (sanitized.stripped) {
      console.warn(`[service] stripped reasoning preamble from model output (${rawText.length - sanitized.text.length} chars)`);
    }
    return {
      text: sanitized.text,
      usage: extractUsage(response),
      stopReason: response?.stopReason,
      toolCalls: response?.toolCalls,
    };
  }
}
