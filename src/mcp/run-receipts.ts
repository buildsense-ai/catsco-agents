/**
 * 定制应用 run 生命周期回执（service_run_receipt）路由器（设计 §19）。
 *
 * 背景：工具桥对超过时间窗（同步 45s + 轮询 90s ≈ 135s）的任务交付"仍运行，可稍后
 * 查询"，此后平台在 run 终态时向调用方账号的在线连接推送回执
 * （receipt_id=rcp_<run_id>，至少一次投递、幂等去重、离线留存补投）。
 * 本模块负责三个纯逻辑环节：
 * 1. 登记"桥已放弃轮询、等待回执"的 run（key=run_id，含对话路由信息）；
 * 2. 对到达的回执去重（receipt_id，TTL+容量双限）并匹配登记项；
 * 3. 生成"唤醒注记"——宿主把它作为运行时观察注入下一次模型回合，
 *    让模型主动用 catsco_run_status 拉取权威结果并交付。
 *
 * 原则：拉取（catsco_run_status）永远是真相通道，回执只负责"叫醒"；
 * 一切内容都不从回执正文读取（回执载荷本身不含 output）。
 */
import { Logger } from '../utils/logger';

/** 平台推送的回执载荷（与 cats-company MsgServiceRunReceipt 同构）。 */
export interface ServiceRunReceipt {
  contract_version?: string;
  receipt_id: string;
  run_id: string;
  session_id: string;
  status: string;
  question?: string;
  error?: string;
  created_at?: string;
}

/** 桥放弃轮询后登记的待补 run。 */
export interface PendingServiceRun {
  runId: string;
  toolName: string;
  /** 平台侧 service run 的会话 id（续聊凭据）。 */
  serviceSessionId: string;
  /** 本机对话路由：本地会话 key（ToolExecutionContext.sessionId）。 */
  conversationSessionKey?: string;
  /** 本机对话路由：平台 topic / chatId（ToolExecutionContext.channel.chatId）。 */
  conversationTopic?: string;
  registeredAt: number;
}

export type RunReceiptDecision =
  | { action: 'wake'; note: string; pending: PendingServiceRun; receipt: ServiceRunReceipt }
  | { action: 'ignored'; reason: 'invalid' | 'duplicate' | 'unmatched' | 'no-conversation' };

export interface ServiceRunReceiptRouterOptions {
  now?: () => number;
  /** 待补登记的存活时长（默认 24h；终端用户长会话场景足够）。 */
  pendingTtlMs?: number;
  /** 待补登记容量上限（LRU 语义：超限淘汰最旧）。 */
  pendingLimit?: number;
  /** 已见回执 id 的去重窗口（默认 24h）。 */
  receiptTtlMs?: number;
  /** 去重表容量上限。 */
  receiptLimit?: number;
}

const DEFAULTS = {
  pendingTtlMs: 24 * 60 * 60 * 1000,
  pendingLimit: 128,
  receiptTtlMs: 24 * 60 * 60 * 1000,
  receiptLimit: 4096,
};

/** 校验并规范化平台回执；字段不全返回 null（绝不让半截载荷触发误唤醒）。 */
export function normalizeServiceRunReceipt(raw: unknown): ServiceRunReceipt | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string).trim() : '');
  const receiptId = str('receipt_id');
  const runId = str('run_id');
  const status = str('status');
  if (!receiptId || !runId || !status) return null;
  const receipt: ServiceRunReceipt = {
    receipt_id: receiptId,
    run_id: runId,
    session_id: str('session_id'),
    status,
  };
  const contractVersion = str('contract_version');
  if (contractVersion) receipt.contract_version = contractVersion;
  const question = str('question');
  if (question) receipt.question = question;
  const error = str('error');
  if (error) receipt.error = error;
  const createdAt = str('created_at');
  if (createdAt) receipt.created_at = createdAt;
  return receipt;
}

/** 生成唤醒注记（交给 session.handleRuntimeObservation 注入）。 */
export function buildServiceRunWakeNote(receipt: ServiceRunReceipt, pending: PendingServiceRun): string {
  const tool = pending.toolName;
  const sid = receipt.session_id || pending.serviceSessionId;
  const sidLine = sid ? `若需继续同一任务的追问，携带 session_id=${sid} 再次调用该工具；` : '';
  if (receipt.status === 'completed') {
    return (
      `[系统] 此前的长任务已结束：定制应用工具「${tool}」的 run 已完成（run_id=${receipt.run_id}）。` +
      `请立即调用 catsco_run_status（run_id 传该值）获取权威结果并交付用户；${sidLine}不要向用户提及本行。`
    );
  }
  if (receipt.status === 'awaiting_input') {
    const question = receipt.question || '（返问内容缺失，请用 catsco_run_status 复核 run）';
    return (
      `[系统] 此前的长任务需要用户补充输入：定制应用工具「${tool}」返回了返问「${question}」。` +
      `请把返问转述给用户；用户补充后携带同一 session_id 再次调用该工具即可续跑。不要向用户提及本行。`
    );
  }
  if (receipt.status === 'failed') {
    const detail = receipt.error ? `（${receipt.error}）` : '';
    return (
      `[系统] 此前的长任务已失败：定制应用工具「${tool}」的 run 失败${detail}。` +
      `请如实告知用户任务未成功并给出可执行建议；可用 catsco_run_status（run_id=${receipt.run_id}）复核详情。不要向用户提及本行。`
    );
  }
  return (
    `[系统] 此前的长任务状态更新：定制应用工具「${tool}」的 run 状态=${receipt.status}（run_id=${receipt.run_id}）。` +
    `请调用 catsco_run_status 复核并按结果处理。不要向用户提及本行。`
  );
}

export class ServiceRunReceiptRouter {
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly pendingLimit: number;
  private readonly receiptTtlMs: number;
  private readonly receiptLimit: number;

  /** run_id → 登记项（Map 插入序即登记序，用于容量淘汰）。 */
  private readonly pending = new Map<string, PendingServiceRun>();
  /** receipt_id → 首次见到的时间戳（去重窗口）。 */
  private readonly seenReceipts = new Map<string, number>();

  constructor(options: ServiceRunReceiptRouterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULTS.pendingTtlMs;
    this.pendingLimit = options.pendingLimit ?? DEFAULTS.pendingLimit;
    this.receiptTtlMs = options.receiptTtlMs ?? DEFAULTS.receiptTtlMs;
    this.receiptLimit = options.receiptLimit ?? DEFAULTS.receiptLimit;
  }

  /** 登记桥已放弃轮询、等待回执的 run；同 run_id 重复登记会覆盖路由信息（更晚的一次更完整）。 */
  registerPendingRun(info: {
    runId: string;
    toolName: string;
    serviceSessionId?: string;
    conversationSessionKey?: string;
    conversationTopic?: string;
  }): void {
    const runId = (info.runId || '').trim();
    if (!runId) return;
    this.prune();
    this.pending.delete(runId);
    this.pending.set(runId, {
      runId,
      toolName: info.toolName,
      serviceSessionId: info.serviceSessionId || '',
      ...(info.conversationSessionKey ? { conversationSessionKey: info.conversationSessionKey } : {}),
      ...(info.conversationTopic ? { conversationTopic: info.conversationTopic } : {}),
      registeredAt: this.now(),
    });
    while (this.pending.size > this.pendingLimit) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 处理一条到达的回执：去重 → 匹配登记项 → 生成唤醒注记。
   * 命中（wake）即消费登记项；ignored 同样计入去重表（至少一次投递不会再触发）。
   */
  handle(raw: unknown): RunReceiptDecision {
    const receipt = normalizeServiceRunReceipt(raw);
    if (!receipt) {
      Logger.warning('[service_run_receipt] 载荷无效，已忽略');
      return { action: 'ignored', reason: 'invalid' };
    }
    this.prune();
    if (this.seenReceipts.has(receipt.receipt_id)) {
      return { action: 'ignored', reason: 'duplicate' };
    }
    this.seenReceipts.set(receipt.receipt_id, this.now());
    while (this.seenReceipts.size > this.receiptLimit) {
      const oldest = this.seenReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.seenReceipts.delete(oldest);
    }

    const pending = this.pending.get(receipt.run_id);
    if (!pending) {
      return { action: 'ignored', reason: 'unmatched' };
    }
    this.pending.delete(receipt.run_id);
    if (!pending.conversationSessionKey || !pending.conversationTopic) {
      // 无对话路由（桥未捕获到上下文，或非聊天场景）：保留日志便于诊断，无法唤醒。
      Logger.warning(
        `[service_run_receipt] run=${receipt.run_id} 已终结但缺少对话路由（sessionKey/topic），无法唤醒`,
      );
      return { action: 'ignored', reason: 'no-conversation' };
    }
    return {
      action: 'wake',
      note: buildServiceRunWakeNote(receipt, pending),
      pending,
      receipt,
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [runId, info] of this.pending) {
      if (now - info.registeredAt > this.pendingTtlMs) this.pending.delete(runId);
    }
    for (const [receiptId, seenAt] of this.seenReceipts) {
      if (now - seenAt > this.receiptTtlMs) this.seenReceipts.delete(receiptId);
    }
  }
}
