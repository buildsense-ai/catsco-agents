# agents/ — CatsCo 服务化 agent 数据包

本目录存放**服务化定制 agent 的数据包**（一份运行时镜像 + N 个数据包中的"N"）。

## 包格式

- **权威格式**：《agent 包与资产体系设计》**§1 manifest v1**（`catsco.service-agent.v1`）与 **§2 引用协议/定义版本**。
- 每个包一个目录 `agents/<slug>/`，至少包含：
  - `agent.json`（manifest；`slug` 必须与目录名一致）
  - `system-prompt.md`（`prompt.system` 指向的文件，须存在且非空）

## 本期（阶段 1）实现约束

- **纯数据包**：不含可执行代码；运行时行为差异全部经 manifest + 提示词 +（阶段 2）技能/知识表达。
- `skills` / `knowledge` 字段仅做结构校验，**内容解析留阶段 2**（见 A 文档 §7 落地分层）。
- 加载器：`src/service/agent-package.ts`（`loadAgentPackage(agentsDir, slug)`）。
- 试点包：`hello/`。

## 现有包

| slug | 名称 | 模型 | 技能 / 知识 |
|---|---|---|---|
| `hello` | Hello 试点应用 | MiniMax-M3 | — / — |
| `weekly-report` | 周报助手 | claude-sonnet-5-5 | company-style / glossary |
| `meeting-notes` | 会议纪要助手 | claude-sonnet-5-5 | minutes-format / glossary |
| `zh-polish` | 中文润色助手 | MiniMax-M3 | company-style / glossary |

知识文件变更**必须同步 `agent.json` 的 sha256 钉定**（LF 规范形）：
`node -e "const fs=require('fs'),c=require('crypto');const r=fs.readFileSync('<file>','utf8');console.log(c.createHash('sha256').update(r.replace(/\r\n/g,'\n'),'utf8').digest('hex'))"`

发布：`node scripts/publish-agent.mjs <slug> --ssh cats-ctyun`（自动注册 + 建版本，实例按 hash 自动拉取）。

## 纪律

- 新增/修改包 → 走仓库 PR；**不要**在包内放密钥、账号或环境相关内容（凭据走运行时 env）。
- slug 字符集：小写字母、数字、连字符（同平台侧约定）。
