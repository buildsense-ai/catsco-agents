/**
 * 服务运行时契约类型（计划② Task 1；对齐计划① 平台内部 API）。
 * 命名与平台侧 JSON 字段一一对应（snake_case），不做转换。
 */

export interface ClaimedRun {
  run_id: string;
  session_id: string;
  definition_rev: number;
  /** 平台侧同步窗口参数（秒）；运行时仅记录日志，窗口内完不成由平台转异步句柄。 */
  threshold_seconds: number;
  input: unknown;
  /** relay 侧服务 token（st1.）；模型调用经它计费到调用方账号。 */
  service_token: string;
  /** 续跑快照（平台下发的最新 checkpoint；无则为空）。 */
  checkpoint?: { revision: number; snapshot: unknown } | null;
}

export interface ServiceRunResult {
  contract_version: 'catsco.service-run-result.v1';
  run_id: string;
  session_id: string;
  status: 'completed';
  output: { text: string };
  /** cost 未知时省略；权威成本以 relay 记账为准。 */
  usage: { prompt_tokens: number; completion_tokens: number; cost_cny?: number };
}

export interface InstanceMetrics {
  active_runs: number;
  completed: number;
  failed: number;
  resumed: number;
  p95_duration_ms: number;
  tokens_total: number;
}
