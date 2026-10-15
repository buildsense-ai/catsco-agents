import { LoadedSkill } from './agent-package';
import { ToolDefinition } from '../types/tool';

/**
 * 服务侧 skill 工具（阶段 2A：prompt 型技能）。
 * 对齐 XiaoBa 主会话的 skill 体验：系统提示只注入技能「清单」，
 * 模型用 skill 工具按需加载全文——长技能不占常驻上下文。
 * 无脚本执行能力（服务实例无设备身份；受控脚本留阶段 2B）。
 */

export const SERVICE_SKILL_TOOL_NAME = 'skill';

export const SERVICE_SKILL_TOOL: ToolDefinition = {
  name: SERVICE_SKILL_TOOL_NAME,
  description:
    '加载一个可用技能的完整说明。当任务与该技能描述匹配时必须先调用它，再按其中的步骤执行。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '技能名称（见可用技能清单）',
        required: true,
      },
    },
    required: ['name'],
  },
};

/** system prompt 尾部的技能清单段（无技能则返回空串）。 */
export function renderSkillsManifest(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return '';
  }
  const lines = skills.map((s) => (s.description ? `- ${s.name}：${s.description}` : `- ${s.name}`));
  return ['', '## 可用技能', '需要时用 skill 工具加载完整说明，再按其中步骤执行：', ...lines].join('\n');
}

/** 执行 skill 工具：返回技能全文（含 [skill:name] 头，对齐 XiaoBa 渲染风格）。 */
export function executeSkillTool(skills: LoadedSkill[], input: unknown): string {
  const name =
    input && typeof input === 'object' && typeof (input as Record<string, unknown>).name === 'string'
      ? ((input as Record<string, unknown>).name as string).trim()
      : '';
  if (!name) {
    return `错误：skill 工具需要 name 参数（可用技能：${skills.map((s) => s.name).join(', ') || '无'}）`;
  }
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    return `错误：未知技能 "${name}"（可用技能：${skills.map((s) => s.name).join(', ') || '无'}）`;
  }
  return `[skill:${skill.name}]\n\n${skill.content}`;
}
