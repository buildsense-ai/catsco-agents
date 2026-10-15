import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentBundle,
  canonicalBundleHash,
  ensureAgentBundleCached,
  isBundleCached,
  parseAgentBundle,
  verifyAgentBundle,
} from '../src/service/agent-bundle';

function fixtureFiles() {
  return [
    {
      path: 'agent.json',
      content:
        '{"schema":"catsco.service-agent.v1","slug":"weekly-report","prompt":{"system":"system-prompt.md"},"behavior":{"async_threshold_seconds":60},"models":["claude-sonnet-5-5"]}',
    },
    { path: 'system-prompt.md', content: '你是周报助手。\n' },
    { path: 'skills/company-style.md', content: '# 文风\n正式。\n' },
    { path: 'knowledge/glossary.md', content: '| 术语 |\n| --- |\n' },
  ];
}

function fixtureBundle(): AgentBundle {
  return { schema: 'catsco.service-agent-bundle.v1', slug: 'weekly-report', files: fixtureFiles() };
}

async function tempCacheRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cats-pkg-'));
  return dir;
}

// 跨语言契约钉定：与 cats-company server/service_agent_bundle_test.go 同 fixture、同期望值。
test('golden hash matches platform implementation', () => {
  const hash = canonicalBundleHash(fixtureFiles());
  assert.equal(hash, '2d5b78ac17ef250323346e330d75b760fffaf9a2f05563bbd387b7fe86f44b48');
});

test('hash is stable across ordering and CRLF, sensitive to tampering', () => {
  const base = canonicalBundleHash(fixtureFiles());
  const reordered = canonicalBundleHash([...fixtureFiles()].reverse());
  assert.equal(reordered, base, 'order must not matter');
  const crlf = fixtureFiles().map((f) => ({ ...f, content: f.content.replace(/\n/g, '\r\n') }));
  assert.equal(canonicalBundleHash(crlf), base, 'CRLF must normalize away');
  const tampered = fixtureFiles();
  tampered[2].content += '（被改动）';
  assert.notEqual(canonicalBundleHash(tampered), base, 'tampering must change the hash');
});

test('parseAgentBundle rejects invalid shapes and unsafe paths', () => {
  const cases: Array<[string, unknown]> = [
    ['bad schema', { ...fixtureBundle(), schema: 'x' }],
    ['bad slug', { ...fixtureBundle(), slug: '../etc' }],
    ['no files', { ...fixtureBundle(), files: [] }],
    ['missing manifest', { ...fixtureBundle(), files: fixtureFiles().slice(1) }],
    ['traversal', { ...fixtureBundle(), files: [...fixtureFiles(), { path: '../evil.md', content: 'x' }] }],
    ['absolute', { ...fixtureBundle(), files: [...fixtureFiles(), { path: '/etc/passwd', content: 'x' }] }],
    ['backslash', { ...fixtureBundle(), files: [...fixtureFiles(), { path: 'a\\b.md', content: 'x' }] }],
    ['duplicate', { ...fixtureBundle(), files: [...fixtureFiles(), { path: 'system-prompt.md', content: 'x' }] }],
    ['non-string content', { ...fixtureBundle(), files: [{ path: 'agent.json', content: 1 }] }],
    ['not an object', 'nope'],
  ];
  for (const [name, raw] of cases) {
    assert.throws(() => parseAgentBundle(raw), new RegExp('.'), `case must throw: ${name}`);
  }
  assert.deepEqual(parseAgentBundle(fixtureBundle()).files.length, 4);
});

test('ensureAgentBundleCached pulls, verifies, materializes and reuses cache', async () => {
  const cacheRoot = await tempCacheRoot();
  const bundle = fixtureBundle();
  const hash = canonicalBundleHash(bundle.files);
  let fetches = 0;

  const agentsDir = await ensureAgentBundleCached(cacheRoot, hash, 'weekly-report', async () => {
    fetches += 1;
    return bundle;
  });
  assert.equal(fetches, 1);
  assert.equal(agentsDir, path.join(cacheRoot, hash, 'agents'));
  assert.ok(await isBundleCached(cacheRoot, hash, 'weekly-report'));
  const manifest = await fs.readFile(path.join(agentsDir, 'weekly-report', 'agent.json'), 'utf8');
  assert.match(manifest, /catsco\.service-agent\.v1/);
  const skill = await fs.readFile(path.join(agentsDir, 'weekly-report', 'skills', 'company-style.md'), 'utf8');
  assert.equal(skill, '# 文风\n正式。\n');

  // 二次调用：缓存命中，不再拉取。
  const again = await ensureAgentBundleCached(cacheRoot, hash, 'weekly-report', async () => {
    fetches += 1;
    return bundle;
  });
  assert.equal(again, agentsDir);
  assert.equal(fetches, 1);
});

test('ensureAgentBundleCached rejects tampered bundles (hash mismatch)', async () => {
  const cacheRoot = await tempCacheRoot();
  const bundle = fixtureBundle();
  const hash = canonicalBundleHash(bundle.files);
  // 平台侧内容被篡改（hash 对不上）→ 拒绝装载，且不落缓存。
  bundle.files[1].content = '恶意提示词';
  await assert.rejects(
    () => ensureAgentBundleCached(cacheRoot, hash, 'weekly-report', async () => bundle),
    /hash mismatch/,
  );
  assert.equal(await isBundleCached(cacheRoot, hash, 'weekly-report'), false);
});

test('ensureAgentBundleCached rejects slug mismatch and concurrent pulls share one fetch', async () => {
  const cacheRoot = await tempCacheRoot();
  const bundle = fixtureBundle();
  const hash = canonicalBundleHash(bundle.files);
  await assert.rejects(
    () => ensureAgentBundleCached(cacheRoot, hash, 'other-slug', async () => bundle),
    /slug mismatch/,
  );

  let fetches = 0;
  const [a, b] = await Promise.all([
    ensureAgentBundleCached(cacheRoot, hash, 'weekly-report', async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return bundle;
    }),
    ensureAgentBundleCached(cacheRoot, hash, 'weekly-report', async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return bundle;
    }),
  ]);
  assert.equal(a, b);
  assert.equal(fetches, 1, 'single-flight');
});

test('verifyAgentBundle accepts LF-normalized content and rejects drift', () => {
  const bundle = fixtureBundle();
  const hash = canonicalBundleHash(bundle.files);
  assert.ok(verifyAgentBundle(bundle, hash));
  const crlf = { ...bundle, files: bundle.files.map((f) => ({ ...f, content: f.content.replace(/\n/g, '\r\n') })) };
  assert.ok(verifyAgentBundle(crlf, hash), 'CRLF payload with LF hash must still verify');
  assert.ok(!verifyAgentBundle(bundle, '0'.repeat(64)));
});
