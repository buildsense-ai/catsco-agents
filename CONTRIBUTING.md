# Contributing — catsco-agents

本仓 = **CatsCo 定制 agent 服务运行时**（XiaoBa-CLI 的专属 fork，upstream = `buildsense-ai/XiaoBa-CLI`）。
服务化开发集中在 `src/service/` 与 `agents/<slug>/`；以下边界纪律与同步 SOP 为仓库长期约束（源自《agent 包与资产体系设计》§6）。

## 仓库边界（三层纪律）

1. **服务层自包含**：`src/service/`、`agents/` 为全新目录，与上游零重叠——上游永远不碰。
2. **共享代码仅 additive**：加可选参数 / 枚举值 / 导出；老调用不传新参时行为逐字节不变。
3. **非 additive = 红线**：需单独评审；属通用改进则择机回流上游（可选）。

「不影响」的验证标准：

- ① 原测试套件全绿
- ② 原模式冒烟（worker 正常连平台跑一轮对话）
- ③ 上游合并压力评估（每次合并记录冲突数）

## 同步上游 SOP

```bash
git fetch upstream
git merge upstream/main     # 用 merge，不用 rebase（自有产品仓）
npm ci && npm run build && node scripts/run-tests.mjs runtime
```

- **频率下限**：至少每月一次，或落后不超过一个版本窗（「纯按需」≈「永远不」，攒大跳跃 = 合并地狱）。
- **红线：不要重写历史**——squash 新起历史 / 乱 rebase 已推历史 → 共同祖先丢失，同步能力真丢。

## 开发流程

- feature 分支 → 本仓 `main`（PR）；每任务一个 commit，前缀 `feat(service):`。
- 构建门槛：`npm run build`（tsc）全绿；新测试放 `tests/service-*.test.ts`（`node scripts/run-tests.mjs runtime` 自动收集，CI 显式列名单）。
- 服务运行时说明：`docs/service-runtime.md`；数据包格式（权威）：`agents/README.md` 及其中引用的设计文档。

## CI

`.github/workflows/ci.yml`：build + 服务运行时套件（**不含任何部署**——运行时部署见计划②运维流程）。
