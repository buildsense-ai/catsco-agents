import { loadAgentPackage, loadAllAgentPackages } from './agent-package';
import { CheckpointCache } from './checkpoint';
import { loadServiceConfig } from './config';
import { ServiceDaemon } from './daemon';
import { RelayModelClient } from './model-client';
import { PlatformClient } from './platform-client';
import { PathResolver } from '../utils/path-resolver';

/**
 * 服务模式入口（计划② Task 6）。
 * 必填 env：CATS_SERVICE_PLATFORM_BASE_URL / CATS_SERVICE_INSTANCE_TOKEN；
 * 默认装载 agents/ 下全部数据包（共享池按 run 选包）；
 * CATS_SERVICE_AGENT_SLUG 如设置则只装载该包（单 agent 限制模式）。
 * 运行：npm run build && npm run service（node dist/service/main.js）
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadServiceConfig(env);
  const singleSlug = (env.CATS_SERVICE_AGENT_SLUG ?? '').trim();
  const packages = singleSlug
    ? new Map([[singleSlug, await loadAgentPackage(config.agentsDir, singleSlug)]])
    : await loadAllAgentPackages(config.agentsDir);
  if (packages.size === 0) {
    throw new Error(`no agent packages found in ${config.agentsDir}`);
  }
  const daemon = new ServiceDaemon({
    config,
    packages,
    model: new RelayModelClient(config.relayBaseUrl),
    platform: new PlatformClient(config),
    checkpointCache: new CheckpointCache(PathResolver.getDataPath('service-checkpoints')),
  });
  const shutdown = (): void => {
    void daemon.shutdown().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(
    `service runtime: agents=${[...packages.keys()].join(',')} instance=${config.instanceId} platform=${config.platformBaseUrl} relay=${config.relayBaseUrl}`,
  );
  await daemon.run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`service runtime failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
