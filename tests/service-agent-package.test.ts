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
  assert.equal(weekly.skills.length, 1);
  assert.equal(weekly.skills[0].name, 'company-style');
  assert.equal(weekly.knowledge.files.length, 1);
  assert.ok(weekly.knowledge.files[0].content.includes('模型接入网关'));
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

test('loads knowledge files with sha256 verification', async () => {
  const pkg = await loadAgentPackage(fixturesDir, 'skilled');
  assert.equal(pkg.knowledge.files.length, 1);
  const faq = pkg.knowledge.files[0];
  assert.equal(faq.path, 'knowledge/faq.md');
  assert.ok(faq.content.includes('专业版'), 'knowledge content loaded');
});

test('runner 字段：缺省 undefined，codex 正常解析（model/sandbox/extra_args）', async () => {
  const plain = await loadAgentPackage(fixturesDir, 'mini');
  assert.equal(plain.runner, undefined);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-runner-'));
  const dir = path.join(tmp, 'cx');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'system-prompt.md'), 'sp');
  await fs.writeFile(
    path.join(dir, 'agent.json'),
    JSON.stringify({
      schema: 'catsco.service-agent.v1',
      slug: 'cx',
      prompt: { system: 'system-prompt.md' },
      model: { primary: { provider: 'openai', model: 'gpt-x' } },
      runner: { type: 'codex', model: 'gpt-5.6-sol', sandbox: 'workspace-write', extra_args: ['--foo', 1] },
    }),
  );
  const pkg = await loadAgentPackage(tmp, 'cx');
  assert.deepEqual(pkg.runner, {
    type: 'codex',
    model: 'gpt-5.6-sol',
    sandbox: 'workspace-write',
    extraArgs: ['--foo'],
  });
});

test('runner 字段：未知 type / 非法 sandbox 直接报错（不静默降级）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-runner-bad-'));
  const write = async (slug: string, runner: unknown): Promise<void> => {
    const dir = path.join(tmp, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'system-prompt.md'), 'sp');
    await fs.writeFile(
      path.join(dir, 'agent.json'),
      JSON.stringify({
        schema: 'catsco.service-agent.v1',
        slug,
        prompt: { system: 'system-prompt.md' },
        model: { primary: { provider: 'openai', model: 'gpt-x' } },
        runner,
      }),
    );
  };
  await write('badtype', { type: 'python' });
  await assert.rejects(loadAgentPackage(tmp, 'badtype'), /runner\.type/);
  await write('badsandbox', { type: 'codex', sandbox: 'danger-full-access' });
  await assert.rejects(loadAgentPackage(tmp, 'badsandbox'), /runner\.sandbox/);
});

test('rejects knowledge with tampered sha256 or missing file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-knowledge-'));
  const dir = path.join(tmp, 'kb');
  await fs.mkdir(path.join(dir, 'knowledge'), { recursive: true });
  await fs.writeFile(path.join(dir, 'system-prompt.md'), 'sp');
  await fs.writeFile(path.join(dir, 'knowledge', 'doc.md'), 'hello knowledge');
  const manifest = (files: unknown): string =>
    JSON.stringify({
      schema: 'catsco.service-agent.v1',
      slug: 'kb',
      name: 'KB',
      prompt: { system: 'system-prompt.md' },
      model: { primary: { provider: 'anthropic', model: 'm' } },
      knowledge: { files },
    });
  await fs.writeFile(path.join(dir, 'agent.json'), manifest([{ path: 'knowledge/doc.md', sha256: 'abc' }]));
  await assert.rejects(loadAgentPackage(tmp, 'kb'), /sha256 mismatch/);
  await fs.writeFile(path.join(dir, 'agent.json'), manifest([{ path: 'knowledge/ghost.md', sha256: 'abc' }]));
  await assert.rejects(loadAgentPackage(tmp, 'kb'), /knowledge file missing/);
  const realHash = (await import('node:crypto')).createHash('sha256').update('hello knowledge').digest('hex');
  await fs.writeFile(path.join(dir, 'agent.json'), manifest([{ path: 'knowledge/doc.md', sha256: realHash }]));
  const ok = await loadAgentPackage(tmp, 'kb');
  assert.equal(ok.knowledge.files[0].content, 'hello knowledge');
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
  // 试点应用启用回合制返问（allow_ask_user=true；设计 §3.3-8）
  assert.equal(pkg.behavior.allowAskUser, true);
});

test('allow_ask_user defaults to false and parses true when set', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-ask-'));
  const dir = path.join(tmp, 'asker');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'system-prompt.md'), 'sp');
  const base = {
    schema: 'catsco.service-agent.v1',
    slug: 'asker',
    name: 'Asker',
    prompt: { system: 'system-prompt.md' },
    model: { primary: { provider: 'anthropic', model: 'm' } },
  };
  // 缺省（无 behavior）
  await fs.writeFile(path.join(dir, 'agent.json'), JSON.stringify(base));
  const plain = await loadAgentPackage(tmp, 'asker');
  assert.equal(plain.behavior.allowAskUser, false);
  // 显式开启
  await fs.writeFile(
    path.join(dir, 'agent.json'),
    JSON.stringify({ ...base, behavior: { async_threshold_seconds: 45, allow_ask_user: true } }),
  );
  const asker = await loadAgentPackage(tmp, 'asker');
  assert.equal(asker.behavior.allowAskUser, true);
  assert.equal(asker.behavior.asyncThresholdSeconds, 45);
});
