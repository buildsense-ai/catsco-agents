import { hostname } from 'node:os';
import * as path from 'node:path';

/** 服务运行时配置（计划② Task 1；env 前缀 CATS_SERVICE_*，全部带默认值+clamp）。 */
export interface ServiceConfig {
  platformBaseUrl: string;
  instanceToken: string;
  instanceId: string;
  relayBaseUrl: string;
  agentsDir: string;
  concurrency: number;
  pollIntervalMs: number;
  heartbeatMs: number;
  shutdownGraceMs: number;
}

const DEFAULTS = {
  relayBaseUrl: 'http://127.0.0.1:18089',
  concurrency: 2,
  pollIntervalMs: 2000,
  heartbeatMs: 10000,
  shutdownGraceMs: 30000,
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
    concurrency: clampInt(env.CATS_SERVICE_CONCURRENCY, DEFAULTS.concurrency, 1, 8),
    pollIntervalMs: clampInt(env.CATS_SERVICE_POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs, 250, 30000),
    heartbeatMs: clampInt(env.CATS_SERVICE_HEARTBEAT_MS, DEFAULTS.heartbeatMs, 1000, 60000),
    shutdownGraceMs: clampInt(env.CATS_SERVICE_SHUTDOWN_GRACE_MS, DEFAULTS.shutdownGraceMs, 0, 120000),
  };
}
