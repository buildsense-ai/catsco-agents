# 服务运行时（src/service）

CatsCo 定制 agent 的执行端：从平台领 run（claim）→ 模型调用（经 relay，服务 token 计费归调用方）→ 事件 / 检查点 / 完成回写。**绝不重头**：会话历史以平台检查点为准，接管续跑从断点继续。

## 架构

```
平台（/api/mcp、/internal/*）                      relay（模型面）
   ▲ claim / 心跳 / 事件 / 检查点 / 完成（实例 token）    ▲ /v1/messages（服务 token）
   │                                                  │
   └──────────── catsco-agents 实例（本仓）─────────────┘
        daemon → session-runner → RelayModelClient
                 ↕ checkpoint（平台权威 + 本地缓存）
        agents/<slug> 数据包（manifest v1 + 提示词）
```

模块：`config`（env 解析 + clamp）、`agent-package`（包加载）、`platform-client`（内部 API，5xx 重试 1 次）、`model-client`（relay anthropic 面）、`session-runner`（run 生命周期）、`checkpoint`（快照语义 + 本地缓存）、`daemon`（claim 循环/租约心跳/实例心跳/优雅退出）、`metrics`。

## 运行

```bash
npm ci
npm run build

# 必填
export CATS_SERVICE_PLATFORM_BASE_URL=<platform-base-url>     # 平台地址
export CATS_SERVICE_INSTANCE_TOKEN=<instance-token>           # 实例 token（平台侧对应 CATS_SERVICE_INSTANCE_TOKEN）
# 可选
export CATS_SERVICE_RELAY_BASE_URL=<relay-base-url>           # 默认 http://127.0.0.1:18089
export CATS_SERVICE_AGENT_SLUG=hello                          # 数据包（默认 hello）
export CATS_SERVICE_INSTANCE_ID=<instance-id>                 # 默认 hostname
export CATS_SERVICE_CONCURRENCY=2                             # 并发背压 1..8（默认 2）

npm run service
```

其余配置（轮询间隔 / 心跳间隔 / 优雅退出宽限 / 本地缓存目录等）见 `src/service/config.ts`——全部带默认值并 clamp。

## 语义要点

- **续跑**：快照只含「已完成轮」（user+assistant 成对）；未完成轮不落盘——接管时重跑该轮、前缀历史原样保留（绝不重头）。
- **优雅退出**（SIGTERM/SIGINT）：停止 claim → 等 ≤ shutdownGraceMs → abort 剩余；**不** complete / fail，租约过期后由其他实例接管。
- **幂等**：complete 带 `result_id`（`res_<run_id>`）；先 `result` 事件、后 `complete`。
- **失败**：任何错误 → 保存「已完成轮」快照后按 abandoned 处理；平台 reaper 在 attempts ≥ 3 时判 failed。
- **服务 token**：claim 时由平台现场签发（`st1.`，平台/relay 同源 HMAC）；模型调用经它把用量计费到调用方 uid。
- **确认方向**：实例→平台、实例→relay 均为出站；内部 API 的部署期网络入口（内网）属运行时部署流程。

## 测试

```bash
npx tsx --test tests/service-*.test.ts
```

覆盖：配置 clamp、包加载校验、平台客户端（重试/鉴权/路由）、模型客户端纯函数、会话运行器（新建/续跑/abort 语义）、daemon（并发/租约心跳/优雅退出）、E2E（mock 平台 + mock relay SSE，含 SIGKILL 杀进程续跑：接管实例收到含第一段历史的 messages、`resumed=1`）。
