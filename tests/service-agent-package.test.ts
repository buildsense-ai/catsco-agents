import { test } from 'node:test';
import * as assert from 'node:assert';
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

test('loads the hello pilot package from the repo agents dir', async () => {
  const agentsDir = path.resolve(__dirname, '..', 'agents');
  const pkg = await loadAgentPackage(agentsDir, 'hello');
  assert.equal(pkg.slug, 'hello');
  assert.equal(pkg.model.primary.model, 'MiniMax-M3');
  assert.ok(pkg.systemPrompt.length > 0);
  assert.equal(pkg.behavior.asyncThresholdSeconds, 60);
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
