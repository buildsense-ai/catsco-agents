import { ToolDefinition } from '../types/tool';

/**
 * 服务侧 ask_user 工具（阶段 2：回合制返问；设计 §3.3-8）。
 * 模型在缺少必要信息且无法合理推断时调用；运行器把本次 run 收尾为
 * awaiting_input（问题作为 output.question 交回调用方），调用方以同一
 * session_id 的下一次 tools/call 补充信息续跑。
 * 仅当包 manifest behavior.allow_ask_user=true 时向模型暴露（默认关闭）。
 */

export const SERVICE_ASK_TOOL_NAME = 'ask_user';

/** 问题文本上限（防超长文本进回执/事件；超出截断）。 */
export const ASK_QUESTION_MAX_CHARS = 2000;

export const SERVICE_ASK_TOOL: ToolDefinition = {
  name: SERVICE_ASK_TOOL_NAME,
  description:
    '当你缺少完成任务所必需的信息、且无法做合理假设时，向调用方提问以补充输入。调用后本次运行会以「待补充输入」结束，调用方补充信息后继续同一会话。不要用它来确认常识或你已经掌握的信息。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '向调用方提出的问题（尽量具体，一次问清所有必要的缺失信息）',
        required: true,
      },
    },
    required: ['question'],
  },
};

/** 提取 ask_user 的问题文本（去空白 + 截断；无有效问题返回空串）。 */
export function extractAskQuestion(input: unknown): string {
  const question =
    input && typeof input === 'object' && typeof (input as Record<string, unknown>).question === 'string'
      ? ((input as Record<string, unknown>).question as string).trim()
      : '';
  if (!question) {
    return '';
  }
  return question.length > ASK_QUESTION_MAX_CHARS ? question.slice(0, ASK_QUESTION_MAX_CHARS) : question;
}
