# catsco-agents

**CatsCo 定制 agent 服务运行时**——XiaoBa-CLI 的专属 fork（upstream：[`buildsense-ai/XiaoBa-CLI`](https://github.com/buildsense-ai/XiaoBa-CLI)）。

本仓承载「agent 版 artifact」（定制化云端 agent 服务）的**执行端**：从平台领取 run → 调模型（经 relay，计费归调用方账号）→ 事件 / 检查点 / 结果回写，支持杀实例后由任意实例**从断点接管续跑**（绝不重头）。

> 产品主体（WebApp / 桌面 / 云端员工）以上游仓库为准；本仓聚焦服务化运行时与 agent 数据包。

## 结构

| 路径 | 说明 |
| --- | --- |
| `src/service/` | 服务运行时（daemon / session-runner / 平台与模型客户端 / 检查点 / 指标） |
| `agents/<slug>/` | 定制 agent 数据包（manifest v1 + 系统提示词；纯数据、无代码） |
| `docs/service-runtime.md` | 运行时架构、环境变量、语义要点 |
| `CONTRIBUTING.md` | 上游边界纪律与同步 SOP（薄差异 / 不重写历史） |

## 快速开始

```bash
npm ci
npm run build
npm run service   # 需 CATS_SERVICE_PLATFORM_BASE_URL / CATS_SERVICE_INSTANCE_TOKEN，详见 docs/service-runtime.md
```

测试：

```bash
npx tsx --test tests/service-*.test.ts   # 服务运行时套件（含杀进程续跑 E2E）
node scripts/run-tests.mjs runtime       # 上游全量回归（同步上游后执行）
```

## 与上游的关系

- 服务化改动局限于 `src/service/`、`agents/`、`docs/`、`tests/service-*`（三层纪律见 `CONTRIBUTING.md`）。
- 同步：`git fetch upstream && git merge upstream/main`（用 merge，不 rebase；**红线=不重写历史**）。
- CI（`.github/workflows/ci.yml`）只做构建 + 服务套件，**不含任何部署**。

## License

本仓为 XiaoBa-CLI 的 fork，许可与上游保持一致。
