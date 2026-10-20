import { AgentPackage, loadAgentPackage } from './agent-package';
import { ensureAgentBundleCached } from './agent-bundle';
import { CheckpointCache } from './checkpoint';
import { pruneCodexWorkspaces } from './codex-runner';
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
  /** 已装载的数据包（共享池：按 claim 的 agent_slug 选包）。 */
  packages: Map<string, AgentPackage>;
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
  /** 云端包进程内缓存（key=<hash>:<slug>；物化目录由 ensureAgentBundleCached 负责磁盘缓存）。 */
  private readonly pulled = new Map<string, AgentPackage>();
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
    let nextWorkspacePruneAt = 0;
    while (!this.shuttingDown) {
      if (Date.now() >= nextWorkspacePruneAt) {
        nextWorkspacePruneAt = Date.now() + WORKSPACE_PRUNE_INTERVAL_MS;
        this.pruneWorkspaces();
      }
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
    const slug = (run.agent_slug ?? '').trim();
    const packageHash = (run.package_hash ?? '').trim();
    let pkg: AgentPackage | undefined;
    let pullError = '';
    if (packageHash && slug) {
      // 云端包分发：按 claim 下发的 hash 拉取（缓存命中直接装载）；失败回退内置包。
      try {
        pkg = await this.resolvePulledPackage(packageHash, slug);
      } catch (err) {
        pullError = (err as Error).message;
        console.warn(`service daemon package pull failed run=${run.run_id} hash=${packageHash}: ${pullError}`);
      }
    }
    if (!pkg) {
      pkg = slug ? this.deps.packages.get(slug) : undefined;
    }
    if (!pkg && !slug && this.deps.packages.size === 1) {
      // 旧平台不下发 agent_slug：单包实例直接用它（向后兼容）。
      pkg = this.deps.packages.values().next().value as AgentPackage;
    }
    if (!pkg) {
      const errorText = `agent package not loaded: ${slug || '(agent_slug missing)'}${
        pullError ? ` (pull failed: ${pullError})` : ''
      }`;
      console.warn(`service daemon ${errorText} run=${run.run_id}`);
      await this.deps.platform.failRun(run.run_id, errorText, false).catch((err: Error) => {
        console.warn(`service daemon fail report failed (${run.run_id}): ${err.message}`);
      });
      return;
    }
    const startedAt = Date.now();
    const resumed = Boolean(run.checkpoint?.snapshot);
    const renewal = setInterval(() => {
      void this.deps.platform.heartbeatRun(run.run_id).catch((err: Error) => {
        console.warn(`service daemon run heartbeat failed (${run.run_id}): ${err.message}`);
      });
    }, this.deps.config.heartbeatMs);
    try {
      const outcome = await runClaimedRun(run, pkg, this.deps.model, this.deps.platform, {
        signal: controller.signal,
        checkpointCache: this.deps.checkpointCache,
        codex: {
          command: this.deps.config.codexCommand,
          homeDir: this.deps.config.codexHomeDir,
          workspaceRoot: this.deps.config.codexWorkspaceRoot,
          sandbox: this.deps.config.codexSandbox,
          ...(this.deps.config.codexProxy ? { proxy: this.deps.config.codexProxy } : {}),
        },
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

  /** 云端包：磁盘缓存命中直接装载；缺失则拉取→复核 hash→物化→装载（成功后进程内缓存）。 */
  private async resolvePulledPackage(packageHash: string, slug: string): Promise<AgentPackage> {
    const key = `${packageHash}:${slug}`;
    const cached = this.pulled.get(key);
    if (cached) {
      return cached;
    }
    const agentsDir = await ensureAgentBundleCached(
      this.deps.config.packageCacheDir,
      packageHash,
      slug,
      () => this.deps.platform.fetchAgentPackage(packageHash),
    );
    const pkg = await loadAgentPackage(agentsDir, slug);
    this.pulled.set(key, pkg);
    return pkg;
  }

  /** 会话工作区定期清理（TTL 来自 CATS_CODEX_WORKSPACE_TTL_DAYS，0=关闭）。 */
  private pruneWorkspaces(): void {
    const ttlMs = this.deps.config.codexWorkspaceTtlDays * 24 * 60 * 60 * 1000;
    if (ttlMs <= 0) return;
    try {
      const { removed, failed } = pruneCodexWorkspaces(this.deps.config.codexWorkspaceRoot, ttlMs);
      if (removed.length > 0) {
        console.log(
          `service daemon workspace prune: removed ${removed.length} (${removed.slice(0, 5).join(',')})`,
        );
      }
      for (const item of failed.slice(0, 3)) {
        console.warn(`service daemon workspace prune failed ${item.name}: ${item.error}`);
      }
    } catch (error) {
      console.warn(`service daemon workspace prune error: ${(error as Error).message}`);
    }
  }

  private async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    }
  }
}

/** 工作区清理扫描间隔（启动即扫一次）。 */
const WORKSPACE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.round(ms * factor));
}
