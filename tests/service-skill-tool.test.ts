import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  SERVICE_SKILL_TOOL,
  SERVICE_SKILL_TOOL_NAME,
  executeSkillTool,
  renderSkillsManifest,
} from '../src/service/skill-tool';
import { LoadedSkill } from '../src/service/agent-package';

const skills: LoadedSkill[] = [
  { name: 'helper', description: '格式化助手技能', content: '# Helper\n内容' },
  { name: 'plain', description: '', content: '# Plain\n内容' },
];

test('skill tool definition matches the skill loader contract', () => {
  assert.equal(SERVICE_SKILL_TOOL.name, SERVICE_SKILL_TOOL_NAME);
  assert.deepEqual(SERVICE_SKILL_TOOL.parameters.required, ['name']);
  assert.equal(SERVICE_SKILL_TOOL.parameters.properties.name.type, 'string');
});

test('renderSkillsManifest lists skills when present and is empty otherwise', () => {
  const manifest = renderSkillsManifest(skills);
  assert.ok(manifest.includes('## 可用技能'));
  assert.ok(manifest.includes('- helper：格式化助手技能'));
  assert.ok(manifest.includes('- plain'));
  assert.equal(renderSkillsManifest([]), '');
});

test('executeSkillTool returns the full skill text with a marker header', () => {
  const out = executeSkillTool(skills, { name: 'helper' });
  assert.ok(out.startsWith('[skill:helper]'));
  assert.ok(out.includes('# Helper'));
});

test('executeSkillTool reports unknown and missing names as text (no throw)', () => {
  const unknown = executeSkillTool(skills, { name: 'nope' });
  assert.ok(unknown.includes('未知技能'));
  assert.ok(unknown.includes('helper'));
  const missing = executeSkillTool(skills, {});
  assert.ok(missing.includes('需要 name 参数'));
});
