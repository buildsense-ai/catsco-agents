import { hostname } from 'node:os';
import * as path from 'node:path';

/** 服务运行时配置（计划② Task 1；env 前缀 CATS_SERVICE_*，全部带默认值+clamp）。 */
export interface ServiceConfig {
  platformBaseUrl: string;
  instanceToken: string;
  instanceId: string;
  relayBaseUrl: string;
  agentsDir: string;
  /** 云端包缓存根目录（<root>/<packageHash>/agents/<slug>/…）。 */
  packageCacheDir: string;
  concurrency: number;
  pollIntervalMs: number;
  heartbeatMs: number;
  shutdownGraceMs: number;
  /** codex 执行后端：命令（默认 codex，可指绝对路径）。 */
  codexCommand: string;
  /** codex 执行后端：CODEX_HOME（认证/配置/会话存储）。 */
  codexHomeDir: string;
  /** codex 执行后端：每会话工作区根目录。 */
  codexWorkspaceRoot: string;
  /** codex 执行后端：出口代理（空=不注入；生产为本地 ssh 隧道地址）。 */
  codexProxy: string;
  /** codex 执行后端：默认沙箱档位。 */
  codexSandbox: 'read-only' | 'workspace-write';
}

const DEFAULTS = {
  relayBaseUrl: 'http://127.0.0.1:18089',
  concurrency: 2,
  pollIntervalMs: 2000,
  heartbeatMs: 10000,
  shutdownGraceMs: 30000,
  codexCommand: 'codex',
  codexHomeDir: '/opt/catsco-agents/env/codex-home',
  codexWorkspaceRoot: '/opt/catsco-agents/workspaces',
} as const;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBaseUrl(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/**
 * 解析服务运行时配置。必填：platformBaseUrl、instanceToken（缺失直接抛错）。
 * 并发只是背压（1..8），不构成对调用方的硬限制。
 */
export function loadServiceConfig(env: Record<string, string | undefined>): ServiceConfig {
  const platformBaseUrl = normalizeBaseUrl(env.CATS_SERVICE_PLATFORM_BASE_URL);
  const instanceToken = (env.CATS_SERVICE_INSTANCE_TOKEN ?? '').trim();
  if (!platformBaseUrl) {
    throw new Error('CATS_SERVICE_PLATFORM_BASE_URL is required');
  }
  if (!instanceToken) {
    throw new Error('CATS_SERVICE_INSTANCE_TOKEN is required');
  }
  return {
    platformBaseUrl,
    instanceToken,
    instanceId: (env.CATS_SERVICE_INSTANCE_ID ?? '').trim() || hostname(),
    relayBaseUrl: normalizeBaseUrl(env.CATS_SERVICE_RELAY_BASE_URL) || DEFAULTS.relayBaseUrl,
    agentsDir: (env.CATS_SERVICE_AGENTS_DIR ?? '').trim() || path.resolve(__dirname, '..', '..', 'agents'),
    packageCacheDir:
      (env.CATS_SERVICE_PACKAGE_CACHE_DIR ?? '').trim() ||
      path.resolve(
        (env.CATS_SERVICE_AGENTS_DIR ?? '').trim() || path.resolve(__dirname, '..', '..', 'agents'),
        '..',
        'service-packages',
      ),
    concurrency: clampInt(env.CATS_SERVICE_CONCURRENCY, DEFAULTS.concurrency, 1, 8),
    pollIntervalMs: clampInt(env.CATS_SERVICE_POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs, 250, 30000),
    heartbeatMs: clampInt(env.CATS_SERVICE_HEARTBEAT_MS, DEFAULTS.heartbeatMs, 1000, 60000),
    shutdownGraceMs: clampInt(env.CATS_SERVICE_SHUTDOWN_GRACE_MS, DEFAULTS.shutdownGraceMs, 0, 120000),
    codexCommand: (env.CATS_CODEX_COMMAND ?? '').trim() || DEFAULTS.codexCommand,
    codexHomeDir: (env.CATS_CODEX_HOME ?? '').trim() || DEFAULTS.codexHomeDir,
    codexWorkspaceRoot: (env.CATS_CODEX_WORKSPACE_ROOT ?? '').trim() || DEFAULTS.codexWorkspaceRoot,
    codexProxy: (env.CATS_CODEX_PROXY ?? '').trim(),
    codexSandbox: (env.CATS_CODEX_SANDBOX ?? '').trim() === 'read-only' ? 'read-only' : 'workspace-write',
  };
}
