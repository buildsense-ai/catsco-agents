#!/usr/bin/env node
/**
 * 发布 agent 包到平台（云端包分发；设计 A §2）。
 *
 * 用法：
 *   node scripts/publish-agent.mjs weekly-report                # 直连平台（默认 http://127.0.0.1:26061，需在平台主机上跑或已建隧道）
 *   node scripts/publish-agent.mjs weekly-report --ssh cats-ctyun   # 经跳板机（bundle 走 stdin，远端 curl；token 从容器 env 现取）
 *   node scripts/publish-agent.mjs weekly-report --dry-run      # 只打包+打印 hash（不发布）
 *   node scripts/publish-agent.mjs weekly-report --out /tmp/x.json
 *   node scripts/publish-agent.mjs --republish <hash> --ssh cats-ctyun   # 回滚：从平台拉回该 hash 的包并 force 重发为新版本
 *
 * 环境变量：CATS_SERVICE_INSTANCE_TOKEN（直连模式 token；ssh 模式忽略）
 * 契约：bundle/hash 算法与平台 server/service_agent_bundle.go 逐字节一致（golden 测试互钉）。
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_SCHEMA = 'catsco.service-agent-bundle.v1';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 64;

function parseArgs(argv) {
  const args = { slug: '', url: 'http://127.0.0.1:26061', ssh: '', container: 'catscompany_prod-server-1', out: '', dryRun: false, token: '', force: false, republish: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--ssh') args.ssh = argv[++i];
    else if (arg === '--container') args.container = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--republish') args.republish = (argv[++i] ?? '').trim();
    else if (arg === '--dry-run') args.dryRun = true;
    else rest.push(arg);
  }
  if (args.republish) {
    if (!/^[a-f0-9]{64}$/.test(args.republish)) {
      console.error('--republish requires a 64-char hex package hash');
      process.exit(2);
    }
    return args; // slug 从拉回的 bundle 推导
  }
  args.slug = rest[0] ?? '';
  if (!args.slug || !/^[a-z0-9-]+$/.test(args.slug)) {
    console.error('usage: publish-agent.mjs <slug> [--dry-run] [--force] [--ssh <alias>] [--url <base>] [--out <file>]');
    console.error('       publish-agent.mjs --republish <package_hash> [--ssh <alias>] [--url <base>]');
    process.exit(2);
  }
  return args;
}

function normalizeLF(content) {
  return content.replace(/\r\n/g, '\n');
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function canonicalHash(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let canonical = '';
  for (const file of sorted) {
    canonical += `${file.path}\n${sha256hex(normalizeLF(file.content))}\n`;
  }
  return sha256hex(canonical);
}

async function collectFiles(dir, prefix = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, rel)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue; // 隐藏文件（.DS_Store 等）不进包
    const raw = await fs.readFile(full);
    if (raw.includes(0)) {
      throw new Error(`binary file not allowed in agent package: ${rel}`);
    }
    const content = raw.toString('utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes: ${rel}`);
    }
    out.push({ path: rel, content });
  }
  return out;
}

async function buildBundle(slug) {
  const dir = path.join(repoRoot, 'agents', slug);
  let files;
  try {
    files = await collectFiles(dir);
  } catch (err) {
    throw new Error(`agent dir unreadable: ${dir} (${err.message})`);
  }
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new Error(`agent package must contain 1..${MAX_FILES} files, got ${files.length}`);
  }
  const total = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`agent package exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
  const manifestRaw = files.find((f) => f.path === 'agent.json')?.content;
  if (!manifestRaw) {
    throw new Error('agent.json missing');
  }
  const manifest = JSON.parse(manifestRaw);
  if (manifest.schema !== 'catsco.service-agent.v1') {
    throw new Error(`agent.json schema must be catsco.service-agent.v1 (got ${manifest.schema})`);
  }
  if (manifest.slug !== slug) {
    throw new Error(`agent.json slug mismatch: ${manifest.slug} != ${slug}`);
  }
  const bundle = { schema: BUNDLE_SCHEMA, slug, files };
  return { bundle, hash: canonicalHash(files) };
}

function run(command, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let bundle;
  let hash;
  if (args.republish) {
    // 回滚通道：从平台拉回指定 hash 的包原文 → 复核 hash → force 重发为新版本。
    bundle = await fetchBundle(args, args.republish);
    hash = canonicalHash(bundle.files ?? []);
    if (hash !== args.republish) {
      throw new Error(`republish hash mismatch: bundle hashes to ${hash}, requested ${args.republish}（拒绝重发被篡改/损坏的包）`);
    }
  } else {
    ({ bundle, hash } = await buildBundle(args.slug));
  }

  const payload = JSON.stringify(bundle);
  const slug = bundle.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`bundle slug invalid: ${slug}`);
  }
  const action = args.republish ? 'republish' : 'packed';
  console.log(`${action} ${slug}: ${bundle.files.length} files, ${payload.length} bytes, package_hash=${hash}`);

  if (args.out) {
    await fs.writeFile(args.out, payload, 'utf8');
    console.log(`bundle written: ${args.out}`);
  }
  if (args.dryRun) {
    return;
  }

  // force（显式指定或回滚重发）：同 hash 也建新版本 → claim 立即切到该内容。
  const force = args.force || Boolean(args.republish);
  const route = `/internal/service-agents/${slug}/publish${force ? '?force=1' : ''}`;
  if (args.ssh) {
    // 远端 curl：token 从容器 env 现取（不落本地、不进 shell 历史）。
    // 注意：TOKEN=$(...) 与 curl 必须在同一条命令行且用 `;` 分隔——用空格会变成临时 env 赋值，$TOKEN 展开为空。
    const remote =
      `TOKEN=$(docker exec ${args.container} printenv CATS_SERVICE_INSTANCE_TOKEN); ` +
      `curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ` +
      `--data-binary @- ${args.url}${route}`;
    const result = await run('ssh', [args.ssh, remote], payload);
    if (result.code !== 0) {
      console.error(result.stderr.trim() || `ssh exit ${result.code}`);
      process.exit(1);
    }
    console.log(result.stdout.trim());
    return;
  }

  const token = args.token || process.env.CATS_SERVICE_INSTANCE_TOKEN || '';
  if (!token) {
    console.error('CATS_SERVICE_INSTANCE_TOKEN is required (or use --ssh <alias>)');
    process.exit(2);
  }
  const response = await fetch(`${args.url}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload,
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`publish failed: HTTP ${response.status} ${text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(text);
}

/** 从平台拉取指定 hash 的包原文（ssh 模式经跳板机；直连模式用实例 token）。 */
async function fetchBundle(args, hash) {
  const route = `/internal/service-agent-packages/${encodeURIComponent(hash)}`;
  let raw;
  if (args.ssh) {
    const remote =
      `TOKEN=$(docker exec ${args.container} printenv CATS_SERVICE_INSTANCE_TOKEN); ` +
      `curl -sS -H "Authorization: Bearer $TOKEN" ${args.url}${route}`;
    const result = await run('ssh', [args.ssh, remote]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `ssh exit ${result.code}`);
    }
    raw = result.stdout;
  } else {
    const token = args.token || process.env.CATS_SERVICE_INSTANCE_TOKEN || '';
    if (!token) {
      throw new Error('CATS_SERVICE_INSTANCE_TOKEN is required (or use --ssh <alias>)');
    }
    const response = await fetch(`${args.url}${route}`, { headers: { authorization: `Bearer ${token}` } });
    raw = await response.text();
    if (!response.ok) {
      throw new Error(`fetch bundle failed: HTTP ${response.status} ${raw.slice(0, 200)}`);
    }
  }
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch {
    throw new Error(`fetch bundle returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (bundle?.schema !== BUNDLE_SCHEMA || !Array.isArray(bundle?.files)) {
    throw new Error('fetched bundle shape invalid');
  }
  return bundle;
}

main().catch((err) => {
  console.error(`publish-agent failed: ${err.message}`);
  process.exit(1);
});
