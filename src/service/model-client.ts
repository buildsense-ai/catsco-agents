import { AnthropicProvider } from '../providers/anthropic-provider';
import { ChatConfig, ChatResponse, Message } from '../types';

/**
 * 模型调用封装（计划② Task 4）。
 * 真实现走 relay 的 anthropic 协议面（POST {relayBaseUrl}/v1/messages 由 provider 构造），
 * apiKey=服务 token（st1.，计费归 caller）；每次 run 新建 provider（token 随 run 变化）。
 * daemon / session-runner 只依赖 ModelClient 接口，测试注入 fake。
 */

/** 服务会话历史消息（checkpoint 快照内使用的稳定形态）。 */
export interface ServiceChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelRunRequest {
  systemPrompt: string;
  messages: ServiceChatMessage[];
  /** 应用的模型绑定（主模型在 [0]；回退列表后续使用）。 */
  models: string[];
  serviceToken: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface ModelRunResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  stopReason?: string;
}

export interface ModelClient {
  run(req: ModelRunRequest): Promise<ModelRunResult>;
}

/** 纯函数：system 提示 + 会话历史 → provider Message[]（system 首条，空提示跳过）。 */
export function buildProviderMessages(systemPrompt: string, history: ServiceChatMessage[]): Message[] {
  const messages: Message[] = [];
  const system = systemPrompt.trim();
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  for (const item of history) {
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
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
      [],
      {
        onText: (delta: string) => {
          streamed += delta;
          req.onText?.(delta);
        },
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    const text = (streamed || response?.content || '').trim();
    return { text, usage: extractUsage(response), stopReason: response?.stopReason };
  }
}
