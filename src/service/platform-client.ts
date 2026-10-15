import { ServiceConfig } from './config';
import { ClaimedRun, InstanceMetrics, ServiceRunResult } from './types';

/**
 * 平台内部 API 客户端（计划② Task 3；契约=计划① Task 8）。
 * 鉴权：每请求携带实例 Bearer token；5xx/网络错误重试 1 次（间隔 retryDelayMs），4xx 直接抛错。
 */

export interface PlatformClientOptions {
  retryDelayMs?: number;
  timeoutMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export class PlatformClient {
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ServiceConfig, opts: PlatformClientOptions = {}) {
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async claim(limit: number): Promise<ClaimedRun[]> {
    const out = await this.request<{ runs?: ClaimedRun[] }>('POST', '/internal/service-runs/claim', {
      limit,
      instance_id: this.cfg.instanceId,
    });
    return out.runs ?? [];
  }

  async heartbeatRun(runId: string): Promise<boolean> {
    const out = await this.request<{ renewed?: boolean }>(
      'POST',
      `/internal/service-runs/${encodeURIComponent(runId)}/heartbeat`,
      { instance_id: this.cfg.instanceId },
    );
    return Boolean(out.renewed);
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<number> {
    const out = await this.request<{ seq?: number }>(
      'POST',
      `/internal/service-runs/${encodeURIComponent(runId)}/events`,
      { type, payload },
    );
    return out.seq ?? 0;
  }

  async saveCheckpoint(runId: string, revision: number, snapshot: unknown): Promise<void> {
    await this.request('POST', `/internal/service-runs/${encodeURIComponent(runId)}/checkpoint`, {
      revision,
      snapshot,
    });
  }

  async completeRun(runId: string, resultId: string, result: ServiceRunResult): Promise<void> {
    await this.request('POST', `/internal/service-runs/${encodeURIComponent(runId)}/complete`, {
      result_id: resultId,
      result,
      usage: result.usage,
    });
  }

  /**
   * 上报不可恢复失败。平台侧端点=联调前待补（阶段 1 运行时以
   * checkpoint+abandoned → 租约过期接管为主路径）；接口保留，端点就位即可用。
   */
  async failRun(runId: string, errorText: string, retryable: boolean): Promise<void> {
    await this.request('POST', `/internal/service-runs/${encodeURIComponent(runId)}/fail`, {
      error_text: errorText,
      retryable,
    });
  }

  /** 按内容 hash 拉取 agent 包（云端包分发；返回原始 bundle，由 agent-bundle 复核 hash）。 */
  async fetchAgentPackage(packageHash: string): Promise<unknown> {
    return this.request('GET', `/internal/service-agent-packages/${encodeURIComponent(packageHash)}`);
  }

  async heartbeatInstance(activeRuns: number, metrics: InstanceMetrics): Promise<void> {
    await this.request('POST', `/internal/service-instances/${encodeURIComponent(this.cfg.instanceId)}/heartbeat`, {
      active_runs: activeRuns,
      metrics,
    });
  }

  private async request<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
      let response: Response;
      try {
        response = await fetch(this.cfg.platformBaseUrl + route, {
          method,
          headers: {
            authorization: `Bearer ${this.cfg.instanceToken}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = new Error(`platform ${method} ${route} network error: ${(err as Error).message}`);
        continue; // 网络层失败 → 重试一次
      }
      if (response.status >= 500) {
        lastError = new Error(`platform ${method} ${route} failed: HTTP ${response.status}`);
        continue; // 5xx → 重试一次
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `platform ${method} ${route} rejected: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`,
        );
      }
      const text = await response.text();
      return (text ? (JSON.parse(text) as T) : (undefined as T));
    }
    throw lastError ?? new Error(`platform ${method} ${route} failed`);
  }
}
