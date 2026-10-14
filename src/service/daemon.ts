import { AgentPackage } from './agent-package';
import { CheckpointCache } from './checkpoint';
import { ServiceConfig } from './config';
import { InstanceMetricsTracker } from './metrics';
import { ModelClient } from './model-client';
import { PlatformClient } from './platform-client';
import { runClaimedRun } from './session-runner';
import { ClaimedRun, InstanceMetrics } from './types';

/**
 * 守护进程（计划② Task 6）。
 * - 主循环：claim(min(concurrency-active, 4))；空转按 pollIntervalMs±20% 抖动退避；
 *   每 heartbeatMs 发实例心跳（携带 metrics 快照）。
 * - 每个 run 由 executeRun 维持租约心跳（heartbeatRun）。
 * - 优雅退出（shutdown）：停止 claim → 等 ≤ shutdownGraceMs → abort 剩余，
 *   runner 保存「已完成轮」快照后返回 abandoned（租约过期由其他实例接管）。
 */

export interface ServiceDaemonDeps {
  config: ServiceConfig;
  pkg: AgentPackage;
  model: ModelClient;
  platform: PlatformClient;
  checkpointCache?: CheckpointCache;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

export class ServiceDaemon {
  private readonly metrics = new InstanceMetricsTracker();
  private readonly active = new Map<string, ActiveRun>();
  private shuttingDown = false;

  constructor(private readonly deps: ServiceDaemonDeps) {}

  get activeCount(): number {
    return this.active.size;
  }

  metricsSnapshot(): InstanceMetrics {
    return this.metrics.snapshot(this.active.size);
  }

  /** 优雅退出；可重复调用。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const deadline = Date.now() + this.deps.config.shutdownGraceMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await sleep(25);
    }
    for (const active of this.active.values()) {
      active.controller.abort();
    }
    await this.waitForIdle();
  }

  /** 主循环：直到 shutdown 后退出（进程收到 SIGTERM 由 main 触发 shutdown）。 */
  async run(): Promise<void> {
    let nextInstanceHeartbeatAt = 0;
    while (!this.shuttingDown) {
      const capacity = Math.min(this.deps.config.concurrency - this.active.size, 4);
      if (capacity > 0) {
        let runs: ClaimedRun[] = [];
        try {
          runs = await this.deps.platform.claim(capacity);
        } catch (err) {
          console.warn(`service daemon claim failed: ${(err as Error).message}`);
        }
        for (const run of runs) {
          this.startRun(run);
        }
        if (runs.length === 0) {
          await sleep(jitter(this.deps.config.pollIntervalMs));
        }
      } else {
        await sleep(jitter(this.deps.config.pollIntervalMs));
      }
      if (Date.now() >= nextInstanceHeartbeatAt) {
        nextInstanceHeartbeatAt = Date.now() + this.deps.config.heartbeatMs;
        try {
          await this.deps.platform.heartbeatInstance(this.active.size, this.metricsSnapshot());
        } catch (err) {
          console.warn(`service daemon instance heartbeat failed: ${(err as Error).message}`);
        }
      }
    }
    await this.waitForIdle();
  }

  private startRun(run: ClaimedRun): void {
    const controller = new AbortController();
    const promise = this.executeRun(run, controller).finally(() => {
      this.active.delete(run.run_id);
    });
    this.active.set(run.run_id, { controller, promise });
  }

  private async executeRun(run: ClaimedRun, controller: AbortController): Promise<void> {
    const startedAt = Date.now();
    const resumed = Boolean(run.checkpoint?.snapshot);
    const renewal = setInterval(() => {
      void this.deps.platform.heartbeatRun(run.run_id).catch((err: Error) => {
        console.warn(`service daemon run heartbeat failed (${run.run_id}): ${err.message}`);
      });
    }, this.deps.config.heartbeatMs);
    try {
      const outcome = await runClaimedRun(run, this.deps.pkg, this.deps.model, this.deps.platform, {
        signal: controller.signal,
        checkpointCache: this.deps.checkpointCache,
        onCompleted: (info) => {
          const tokens = info.usage.promptTokens + info.usage.completionTokens;
          this.metrics.record('completed', Date.now() - startedAt, tokens, info.resumed);
        },
      });
      if (outcome === 'abandoned') {
        this.metrics.record('abandoned', Date.now() - startedAt, 0, resumed);
      }
    } finally {
      clearInterval(renewal);
    }
  }

  private async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.round(ms * factor));
}
