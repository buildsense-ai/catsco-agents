/**
 * E2E 子进程夹具：以真 HTTP 客户端跑服务守护进程（供 SIGKILL 场景）。
 * env 由测试注入：CATS_SERVICE_PLATFORM_BASE_URL / CATS_SERVICE_INSTANCE_TOKEN /
 * CATS_SERVICE_RELAY_BASE_URL / CATS_SERVICE_AGENTS_DIR / CATS_SERVICE_INSTANCE_ID 等。
 */
import { loadAllAgentPackages } from '../../../src/service/agent-package';
import { loadServiceConfig } from '../../../src/service/config';
import { ServiceDaemon } from '../../../src/service/daemon';
import { RelayModelClient } from '../../../src/service/model-client';
import { PlatformClient } from '../../../src/service/platform-client';

async function main(): Promise<void> {
  const config = loadServiceConfig(process.env);
  const packages = await loadAllAgentPackages(config.agentsDir);
  const daemon = new ServiceDaemon({
    config,
    packages,
    model: new RelayModelClient(config.relayBaseUrl),
    platform: new PlatformClient(config),
  });
  await daemon.run();
}

main().catch((err) => {
  console.error(`child daemon failed: ${(err as Error).message}`);
  process.exit(1);
});
