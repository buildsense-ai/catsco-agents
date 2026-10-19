import { test } from 'node:test';
import * as assert from 'node:assert';
import { buildProviderMessages, extractUsage, stripReasoningPreamble } from '../src/service/model-client';

test('buildProviderMessages prepends system and maps history', () => {
  const messages = buildProviderMessages(' You are X. ', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'next' },
  ]);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], { role: 'system', content: 'You are X.' });
  assert.deepEqual(messages[1], { role: 'user', content: 'hi' });
  assert.deepEqual(messages[2], { role: 'assistant', content: 'hello' });
  assert.deepEqual(messages[3], { role: 'user', content: 'next' });
});

test('buildProviderMessages skips empty system prompt', () => {
  const messages = buildProviderMessages('   ', [{ role: 'user', content: 'hi' }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
});

test('extractUsage maps token fields with defaults', () => {
  assert.deepEqual(extractUsage(undefined), { promptTokens: 0, completionTokens: 0 });
  assert.deepEqual(
    extractUsage({ content: 'x', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } }),
    { promptTokens: 3, completionTokens: 5 },
  );
});

test('stripReasoningPreamble：剥离英文 CoT 序言、保留标题起的正文', () => {
  const leaked =
    'The user has provided their weekly work notes. Let me analyze the input:\n' +
    '1. item one\n2. item two\n\nLet me draft the report:\n\n' +
    '# 周报（日期待确认）\n\n## 本周完成\n- 联调新对账系统\n';
  const out = stripReasoningPreamble(leaked);
  assert.equal(out.stripped, true);
  assert.match(out.text, /^# 周报（日期待确认）/);
  assert.ok(!out.text.includes('Let me analyze'));
});

test('stripReasoningPreamble：中文过程叙述序言同样剥离', () => {
  const leaked = '用户提供了本周的工作记录。让我先分析一下要点：\n- 改 bug\n- 开会\n\n# 周报\n\n## 本周完成\n- …\n';
  const out = stripReasoningPreamble(leaked);
  assert.equal(out.stripped, true);
  assert.match(out.text, /^# 周报/);
});

test('stripReasoningPreamble：已在标题开头的正文不动', () => {
  const clean = '# 周报\n\n## 本周完成\n- 完成 A\n';
  const out = stripReasoningPreamble(clean);
  assert.equal(out.stripped, false);
  assert.equal(out.text, clean);
});

test('stripReasoningPreamble：无标题的普通回复（问候/返问）不动', () => {
  const ask = '这条输入只有一句话，没有决议或待办可以提取。\n请问：这次会议主要讨论了什么？';
  const out = stripReasoningPreamble(ask);
  assert.equal(out.stripped, false);
  assert.equal(out.text, ask);
});

test('stripReasoningPreamble：标题前是正当铺垫（非推理口吻）不剥离', () => {
  const legit = '相关数字均按原文保留。\n\n## 润色稿\n正文…';
  const out = stripReasoningPreamble(legit);
  assert.equal(out.stripped, false);
  assert.equal(out.text, legit);
});

test('stripReasoningPreamble：序言空行/空白不误报', () => {
  const spaced = '\n\n  \n# 会议纪要：测试\n内容';
  const out = stripReasoningPreamble(spaced);
  assert.equal(out.stripped, false);
  assert.equal(out.text, spaced.trim() === '' ? spaced : out.text);
  assert.match(out.text, /# 会议纪要/);
});

test('stripReasoningPreamble：序言为双语混合仍能识别推理特征', () => {
  const leaked = '让我分析一下输入：The user wants a weekly report.\n\n# 周报（估计）\n## 本周完成\n- A';
  const out = stripReasoningPreamble(leaked);
  assert.equal(out.stripped, true);
  assert.match(out.text, /^# 周报/);
});

test('stripReasoningPreamble：中文输入 + 无标题返问——剥离开头英文 CoT 块', () => {
  const leaked =
    'The user\'s input is just "帮我写个周报。" (Help me write a weekly report); I need to ask one focused question.\n' +
    '\n' +
    '这周都做了哪些事？请列一下即可。';
  const out = stripReasoningPreamble(leaked, { inputHasChinese: true });
  assert.equal(out.stripped, true);
  assert.match(out.text, /^这周都做了哪些事/);
});

test('stripReasoningPreamble：答案与推理粘在同一行（句级尾锚）', () => {
  const leaked =
    'The user provided a weekly report request. I should just ask the one focused question directly.' +
    '这周你做了哪些事？把每天零散的记录贴过来就行，我整理成周报。';
  const out = stripReasoningPreamble(leaked, { inputHasChinese: true });
  assert.equal(out.stripped, true);
  assert.match(out.text, /^这周你做了哪些事/);
});

test('stripReasoningPreamble：CoT 引用中文指令后仍能剥到问题本身', () => {
  const leaked =
    'According to the instructions, "返问场景同样只输出那一个问题本身，不要叙述判断过程". ' +
    'So I should just ask the focused question.这周你做了哪些事？请补充。';
  const out = stripReasoningPreamble(leaked, { inputHasChinese: true });
  assert.equal(out.stripped, true);
  assert.match(out.text, /^这周你做了哪些事/);
});

test('stripReasoningPreamble：英文输入不启无标题剥离', () => {
  const english = 'Here is your weekly report summary. Let me know if you need changes.';
  const out = stripReasoningPreamble(english, { inputHasChinese: false });
  assert.equal(out.stripped, false);
  assert.equal(out.text, english);
});

test('stripReasoningPreamble：中文输出本以中文开头不误剪', () => {
  const clean = 'SQL 优化建议如下：为慢查询加索引，并复核执行计划。';
  const out = stripReasoningPreamble(clean, { inputHasChinese: true });
  assert.equal(out.stripped, false);
});

test('stripReasoningPreamble：头部英文量不足（正当短呼）不剥离', () => {
  const legit = 'OK。已按你的要求完成交付。';
  const out = stripReasoningPreamble(legit, { inputHasChinese: true });
  assert.equal(out.stripped, false);
});

test('stripReasoningPreamble：中英混合正当回复（英文头短）不剥离', () => {
  const legit = 'SQL fix applied. 已修复登录问题。详情：加了参数化查询。';
  const out = stripReasoningPreamble(legit, { inputHasChinese: true });
  assert.equal(out.stripped, false);
});
