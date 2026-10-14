import { loadAgentPackage } from './agent-package';
import { CheckpointCache } from './checkpoint';
import { loadServiceConfig } from './config';
import { ServiceDaemon } from './daemon';
import { RelayModelClient } from './model-client';
import { PlatformClient } from './platform-client';
import { PathResolver } from '../utils/path-resolver';

/**
 * 服务模式入口（计划② Task 6）。
 * 必填 env：CATS_SERVICE_PLATFORM_BASE_URL / CATS_SERVICE_INSTANCE_TOKEN；
 * CATS_SERVICE_AGENT_SLUG 选包（默认 hello）；其余见 config.ts。
 * 运行：npm run build && npm run service（node dist/service/main.js）
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadServiceConfig(env);
  const slug = (env.CATS_SERVICE_AGENT_SLUG ?? '').trim() || 'hello';
  const pkg = await loadAgentPackage(config.agentsDir, slug);
  const daemon = new ServiceDaemon({
    config,
    pkg,
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
    `service runtime: agent=${slug} instance=${config.instanceId} platform=${config.platformBaseUrl} relay=${config.relayBaseUrl}`,
  );
  await daemon.run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`service runtime failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
