/**
 * 服务运行时契约类型（计划② Task 1；对齐计划① 平台内部 API）。
 * 命名与平台侧 JSON 字段一一对应（snake_case），不做转换。
 */

export interface ClaimedRun {
  run_id: string;
  session_id: string;
  /** 平台下发的 agent 标识（共享池选包依据；旧平台可不带）。 */
  agent_slug?: string;
  /** 平台下发的包内容 hash（云端包分发；缺省=平台无包，回退内置包）。 */
  package_hash?: string;
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
  /**
   * completed：正常完成（output.text=答复）；
   * awaiting_input：回合制返问收尾（output.question=待补充问题；调用方以同一
   * session_id 的下一次 tools/call 补充续跑——设计 §3.3-8）。
   */
  status: 'completed' | 'awaiting_input';
  output: { text?: string; question?: string };
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
