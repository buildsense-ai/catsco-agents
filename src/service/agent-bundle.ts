import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 云端包拉取（设计 A §2：发布=数据包；平台内容寻址分发）。
 *
 * 契约（与平台 server/service_agent_bundle.go 逐字节一致）：
 *  - bundle JSON：{ schema: catsco.service-agent-bundle.v1, slug, files: [{path, content}] }
 *  - package_hash = sha256(canonical)，canonical = 按 path 升序拼接 "<path>\n<sha256hex(LF 归一化 content)>\n"
 *  - 实例侧**复核**下载内容 hash（内容寻址自校验：平台被篡改/传输损坏 → 拒绝装载）
 *
 * 缓存布局：<cacheRoot>/<packageHash>/agents/<slug>/…（物化后 loadAgentPackage 直接装载，
 * 与内置包同一条解析路径）；.bundle-ready 标记文件 = 完整物化凭据。
 */

export const SERVICE_AGENT_BUNDLE_SCHEMA = 'catsco.service-agent-bundle.v1';

export interface AgentBundleFile {
  path: string;
  content: string;
}

export interface AgentBundle {
  schema: string;
  slug: string;
  files: AgentBundleFile[];
}

const BUNDLE_READY_MARKER = '.bundle-ready';
const slugPattern = /^[a-z0-9-]+$/;

/** 行尾归一化（契约第 1 步；文本文件语义不受行尾影响）。 */
export function normalizeBundleLF(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function digestsByPath(files: AgentBundleFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let canonical = '';
  for (const file of sorted) {
    const digest = crypto.createHash('sha256').update(normalizeBundleLF(file.content), 'utf8').digest('hex');
    canonical += `${file.path}\n${digest}\n`;
  }
  return canonical;
}

/** 内容寻址 hash（契约第 2/3 步）。 */
export function canonicalBundleHash(files: AgentBundleFile[]): string {
  return crypto.createHash('sha256').update(digestsByPath(files), 'utf8').digest('hex');
}

function validateBundlePath(p: string): void {
  if (!p) {
    throw new Error('bundle file path empty');
  }
  if (p.length > 200) {
    throw new Error(`bundle file path too long: ${p}`);
  }
  if (p.startsWith('/') || p.includes('\\')) {
    throw new Error(`bundle file path must be relative with forward slashes: ${p}`);
  }
  for (const part of p.split('/')) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`bundle file path has unsafe segment: ${p}`);
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) {
    throw new Error(`bundle file path has control characters: ${p}`);
  }
}

/** 解析并校验平台下发的 bundle（形状/路径安全；hash 校验由 verifyAgentBundle 负责）。 */
export function parseAgentBundle(raw: unknown): AgentBundle {
  if (!raw || typeof raw !== 'object') {
    throw new Error('agent bundle must be an object');
  }
  const candidate = raw as Partial<AgentBundle>;
  if (candidate.schema !== SERVICE_AGENT_BUNDLE_SCHEMA) {
    throw new Error(`agent bundle schema must be ${SERVICE_AGENT_BUNDLE_SCHEMA}`);
  }
  if (!candidate.slug || !slugPattern.test(candidate.slug)) {
    throw new Error('agent bundle slug invalid');
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw new Error('agent bundle files required');
  }
  const seen = new Set<string>();
  const files: AgentBundleFile[] = [];
  for (const file of candidate.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('agent bundle file requires string path and content');
    }
    validateBundlePath(file.path);
    if (seen.has(file.path)) {
      throw new Error(`agent bundle duplicate file path: ${file.path}`);
    }
    seen.add(file.path);
    files.push({ path: file.path, content: file.content });
  }
  if (!seen.has('agent.json')) {
    throw new Error('agent bundle missing agent.json');
  }
  return { schema: candidate.schema, slug: candidate.slug, files };
}

/** 复核 hash（内容寻址自校验）。 */
export function verifyAgentBundle(bundle: AgentBundle, expectedHash: string): boolean {
  return canonicalBundleHash(bundle.files) === expectedHash;
}

/** 该 hash 是否已完整物化（标记文件 + agent.json 双查）。 */
export async function isBundleCached(cacheRootDir: string, packageHash: string, slug: string): Promise<boolean> {
  const hashDir = path.join(cacheRootDir, packageHash);
  const marker = path.join(hashDir, BUNDLE_READY_MARKER);
  const manifest = path.join(hashDir, 'agents', slug, 'agent.json');
  const [markerOk, manifestOk] = await Promise.all([isFile(marker), isFile(manifest)]);
  return markerOk && manifestOk;
}

/**
 * 物化 bundle 到缓存（原子：临时目录写完再 rename；并发/多实例同 hash 竞争安全）。
 * 返回该 hash 的 agents 目录（可直接传给 loadAgentPackage）。
 */
export async function materializeAgentBundle(
  cacheRootDir: string,
  packageHash: string,
  bundle: AgentBundle,
): Promise<string> {
  const hashDir = path.join(cacheRootDir, packageHash);
  const agentsDir = path.join(hashDir, 'agents');
  if (await isBundleCached(cacheRootDir, packageHash, bundle.slug)) {
    return agentsDir;
  }
  const tmpDir = path.join(cacheRootDir, `.tmp-${packageHash.slice(0, 12)}-${crypto.randomBytes(4).toString('hex')}`);
  const slugDir = path.join(tmpDir, 'agents', bundle.slug);
  await fs.mkdir(slugDir, { recursive: true });
  for (const file of bundle.files) {
    const target = path.join(slugDir, ...file.path.split('/'));
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(slugDir) + path.sep)) {
      throw new Error(`agent bundle path escapes slug dir: ${file.path}`);
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, file.content, 'utf8');
  }
  await fs.writeFile(path.join(tmpDir, BUNDLE_READY_MARKER), packageHash, 'utf8');
  await fs.mkdir(cacheRootDir, { recursive: true });
  try {
    await fs.rename(tmpDir, hashDir);
  } catch (err) {
    // 竞争落败（目录已存在）→ 用既有物化结果；其余错误上抛。
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    if (!(await isBundleCached(cacheRootDir, packageHash, bundle.slug))) {
      throw err;
    }
  }
  return agentsDir;
}

/**
 * 确保 hash 对应包已在缓存（缺失时经 fetchBundle 拉取 → 解析 → hash 复核 → 物化）。
 * 单飞：同 hash 并发调用共享同一次拉取。
 */
export async function ensureAgentBundleCached(
  cacheRootDir: string,
  packageHash: string,
  slug: string,
  fetchBundle: () => Promise<unknown>,
): Promise<string> {
  const hashDir = path.join(cacheRootDir, packageHash);
  const agentsDir = path.join(hashDir, 'agents');
  if (await isBundleCached(cacheRootDir, packageHash, slug)) {
    return agentsDir;
  }
  const key = `${path.resolve(cacheRootDir)}\u0000${packageHash}`;
  let inflight = inflightPulls.get(key);
  if (!inflight) {
    inflight = (async () => {
      const raw = await fetchBundle();
      const bundle = parseAgentBundle(raw);
      if (bundle.slug !== slug) {
        throw new Error(`agent bundle slug mismatch: ${bundle.slug} != ${slug}`);
      }
      if (!verifyAgentBundle(bundle, packageHash)) {
        throw new Error(`agent bundle hash mismatch for ${packageHash}（拒绝装载被篡改/损坏的包）`);
      }
      return materializeAgentBundle(cacheRootDir, packageHash, bundle);
    })().finally(() => {
      inflightPulls.delete(key);
    });
    inflightPulls.set(key, inflight);
  }
  return inflight;
}

const inflightPulls = new Map<string, Promise<string>>();

async function isFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}
