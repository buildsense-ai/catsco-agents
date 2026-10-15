import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAgentPackage, loadAllAgentPackages } from '../src/service/agent-package';

const fixturesDir = path.join(__dirname, 'fixtures', 'agents');

test('loads package and rejects mismatches', async () => {
  const pkg = await loadAgentPackage(fixturesDir, 'mini');
  assert.equal(pkg.slug, 'mini');
  assert.equal(pkg.name, 'Mini Fixture');
  assert.ok(pkg.systemPrompt.includes('fixture'));
  assert.equal(pkg.model.primary.model, 'fixture-model');
  assert.equal(pkg.behavior.asyncThresholdSeconds, 30);
  assert.equal(pkg.behavior.maxRunSeconds, 60);
  await assert.rejects(loadAgentPackage(fixturesDir, 'missing'), /not found/);
  await assert.rejects(loadAgentPackage(fixturesDir, 'broken'), /slug/);
  await assert.rejects(loadAgentPackage(fixturesDir, 'noprompt'), /system prompt/);
});

test('loads all packages from the repo agents dir', async () => {
  const agentsDir = path.resolve(__dirname, '..', 'agents');
  const packages = await loadAllAgentPackages(agentsDir);
  assert.ok(packages.has('hello'), 'hello package should load');
  assert.ok(packages.has('weekly-report'), 'weekly-report package should load');
  const weekly = packages.get('weekly-report')!;
  assert.equal(weekly.model.primary.model, 'claude-sonnet-5-5');
  assert.equal(weekly.behavior.asyncThresholdSeconds, 60);
  assert.ok(weekly.systemPrompt.includes('Weekly Report'));
});

test('loads bundle skills with explicit and default paths', async () => {
  const pkg = await loadAgentPackage(fixturesDir, 'skilled');
  assert.equal(pkg.skills.length, 2);
  const helper = pkg.skills.find((s) => s.name === 'helper')!;
  assert.equal(helper.description, '格式化助手技能');
  assert.ok(helper.content.includes('格式化结果'), 'explicit path skill content');
  const plain = pkg.skills.find((s) => s.name === 'plain')!;
  assert.ok(plain.content.includes('默认路径'), 'default path skills/<name>.md');
});

test('rejects skillhub-sourced skills and missing skill files', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-skill-'));
  const write = async (manifest: unknown): Promise<void> => {
    const dir = path.join(tmp, 'broken');
    await fs.mkdir(path.join(dir, 'skills'), { recursive: true });
    await fs.writeFile(path.join(dir, 'agent.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'system-prompt.md'), 'sp');
  };
  const base = {
    schema: 'catsco.service-agent.v1',
    slug: 'broken',
    name: 'Broken',
    prompt: { system: 'system-prompt.md' },
    model: { primary: { provider: 'anthropic', model: 'm' } },
  };
  await write({ ...base, skills: [{ name: 'x', source: 'skillhub' }] });
  await assert.rejects(loadAgentPackage(tmp, 'broken'), /not supported/);
  await write({ ...base, skills: [{ name: 'ghost' }] });
  await assert.rejects(loadAgentPackage(tmp, 'broken'), /skill file missing/);
});

test('loads the hello pilot package from the repo agents dir', async () => {
  const agentsDir = path.resolve(__dirname, '..', 'agents');
  const pkg = await loadAgentPackage(agentsDir, 'hello');
  assert.equal(pkg.slug, 'hello');
  assert.equal(pkg.model.primary.model, 'MiniMax-M3');
  assert.ok(pkg.systemPrompt.length > 0);
  assert.equal(pkg.behavior.asyncThresholdSeconds, 60);
});
