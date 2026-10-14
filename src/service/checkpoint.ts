import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ServiceChatMessage } from './model-client';

/**
 * 会话检查点（计划② Task 5）。
 * 语义（测试锁死）：快照只包含「已完成轮」的成对消息（user+assistant）；
 * 未完成轮不落盘——接管时重跑该轮，但前缀历史原样保留（绝不重头）。
 */

export interface ServiceCheckpoint {
  v: 1;
  revision: number;
  history: ServiceChatMessage[];
}

/** 纯函数：基于上一版快照构建下一版（revision 单调递增）。 */
export function buildNextCheckpoint(
  previous: ServiceCheckpoint | undefined | null,
  history: ServiceChatMessage[],
): ServiceCheckpoint {
  const base = previous?.revision ?? 0;
  return { v: 1, revision: Math.max(0, base) + 1, history };
}

/** 纯函数：解析平台下发的 checkpoint snapshot（宽容：坏形状按 null 处理）。 */
export function parseCheckpointSnapshot(snapshot: unknown): ServiceCheckpoint | null {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  const raw = snapshot as { v?: unknown; revision?: unknown; history?: unknown };
  if (!Array.isArray(raw.history)) {
    return null;
  }
  const history: ServiceChatMessage[] = [];
  for (const item of raw.history) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const msg = item as { role?: unknown; content?: unknown };
    if ((msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string') {
      history.push({ role: msg.role, content: msg.content });
    }
  }
  return {
    v: 1,
    revision: Number.isFinite(raw.revision) ? (raw.revision as number) : 0,
    history,
  };
}

/**
 * 本地缓存（非权威：平台 checkpoint 为准；仅便于排查与快速恢复）。
 * 写入失败不抛出——不能影响主流程（平台侧快照已保存）。
 */
export class CheckpointCache {
  constructor(private readonly dir: string) {}

  async save(sessionId: string, checkpoint: ServiceCheckpoint): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(path.join(this.dir, `${sessionId}.json`), JSON.stringify(checkpoint), 'utf8');
    } catch {
      // 忽略：本地缓存是尽力而为
    }
  }
}
