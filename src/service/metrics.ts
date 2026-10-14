import { InstanceMetrics } from './types';

const P95_WINDOW = 100;

/** 轻量指标（计划② Task 6）：计数 + 最近 100 次耗时 p95 + tokens 累计（进实例心跳）。 */
export class InstanceMetricsTracker {
  private completed = 0;
  private failed = 0;
  private resumed = 0;
  private tokensTotal = 0;
  private readonly durations: number[] = [];

  record(outcome: 'completed' | 'abandoned', durationMs: number, tokens: number, wasResumed: boolean): void {
    if (outcome === 'completed') {
      this.completed += 1;
    } else {
      // abandoned 视作未完成（真正 failed 由平台侧 attempts 上限判定）
      this.failed += 1;
    }
    if (wasResumed) {
      this.resumed += 1;
    }
    this.tokensTotal += tokens;
    this.durations.push(durationMs);
    if (this.durations.length > P95_WINDOW) {
      this.durations.shift();
    }
  }

  snapshot(activeRuns: number): InstanceMetrics {
    return {
      active_runs: activeRuns,
      completed: this.completed,
      failed: this.failed,
      resumed: this.resumed,
      p95_duration_ms: percentile95(this.durations),
      tokens_total: this.tokensTotal,
    };
  }
}

/** 纯函数：95 分位（空数组=0）。 */
export function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}
