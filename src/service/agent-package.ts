import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * agent 包加载器（计划② Task 2）。
 * 包格式权威：A 文档《agent 包与资产体系设计》§1 manifest v1（catsco.service-agent.v1）。
 * 本期约束：纯数据包（不含可执行代码）；skills/knowledge 只校验字段结构，内容解析留阶段 2。
 */

export interface ModelBinding {
  provider: string;
  model: string;
  reasoning_effort?: string;
}

export interface SkillRef {
  name: string;
  description?: string;
  /** 包内相对路径；缺省 skills/<name>.md。 */
  path?: string;
  /** 引用型技能（如 skillhub）——本阶段不支持，出现即报错。 */
  source?: string;
}

/** 已加载的技能（prompt 型：全文随包分发，模型经 skill 工具按需加载）。 */
export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
}

export interface KnowledgeFileRef {
  path: string;
  sha256: string;
}

/** 已加载的知识文件（全量注入档：内容随包分发，拼进 system prompt）。 */
export interface LoadedKnowledge {
  path: string;
  content: string;
}

export interface AgentPackage {
  slug: string;
  name: string;
  systemPrompt: string;
  model: { primary: ModelBinding; fallbacks: ModelBinding[] };
  behavior: { asyncThresholdSeconds: number; maxRunSeconds: number };
  skills: LoadedSkill[];
  knowledge: { files: LoadedKnowledge[] };
}

/** 知识全量注入的上限（防炸上下文；超出报错，促使用技能/拆分）。 */
export const KNOWLEDGE_MAX_FILE_BYTES = 32 * 1024;
export const KNOWLEDGE_MAX_TOTAL_BYTES = 96 * 1024;

const AGENT_SCHEMA = 'catsco.service-agent.v1';

interface AgentManifest {
  schema?: string;
  slug?: string;
  name?: string;
  prompt?: { system?: string };
  model?: { primary?: Partial<ModelBinding>; fallbacks?: Partial<ModelBinding>[] };
  behavior?: { async_threshold_seconds?: number; max_run_seconds?: number };
  skills?: SkillRef[];
  knowledge?: { files?: KnowledgeFileRef[] };
}

function normalizeBinding(raw: Partial<ModelBinding> | undefined): ModelBinding {
  if (!raw || !raw.provider || !raw.model) {
    throw new Error('model binding requires provider and model');
  }
  const binding: ModelBinding = { provider: raw.provider, model: raw.model };
  if (raw.reasoning_effort) {
    binding.reasoning_effort = raw.reasoning_effort;
  }
  return binding;
}

/** system prompt 尾部的知识段（全量注入档；无知识返回空串）。 */
export function renderKnowledgeBlock(files: LoadedKnowledge[]): string {
  if (files.length === 0) {
    return '';
  }
  const parts = ['', '## 知识', '以下为随应用分发的参考资料，回答时以此为准：'];
  for (const file of files) {
    parts.push('', `### ${file.path}`, file.content);
  }
  return parts.join('\n');
}

/**
 * 装载 agentsDir 下全部合法包（共享池：实例=通用工人，按 run 的 agent_slug 选包）。
 * 非法 slug 目录（含非字母数字连字符）跳过；遇到合法 slug 但包内容损坏 → 抛错（fail-fast）。
 */
export async function loadAllAgentPackages(agentsDir: string): Promise<Map<string, AgentPackage>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch {
    throw new Error(`agents dir not found: ${agentsDir}`);
  }
  const packages = new Map<string, AgentPackage>();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const slug = entry.name;
    if (!/^[a-z0-9-]+$/.test(slug)) {
      continue;
    }
    packages.set(slug, await loadAgentPackage(agentsDir, slug));
  }
  return packages;
}

export async function loadAgentPackage(agentsDir: string, slug: string): Promise<AgentPackage> {
  const packageDir = path.join(agentsDir, slug);
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(packageDir, 'agent.json'), 'utf8');
  } catch {
    throw new Error(`agent package not found: ${slug}`);
  }
  let manifest: AgentManifest;
  try {
    manifest = JSON.parse(manifestRaw) as AgentManifest;
  } catch (err) {
    throw new Error(`agent package ${slug}: invalid agent.json (${(err as Error).message})`);
  }
  if (manifest.schema !== AGENT_SCHEMA) {
    throw new Error(`agent package ${slug}: schema must be ${AGENT_SCHEMA}`);
  }
  if (manifest.slug !== slug) {
    throw new Error(`agent package ${slug}: manifest slug mismatch (${manifest.slug ?? '(missing)'})`);
  }
  const primary = normalizeBinding(manifest.model?.primary);
  const fallbacks: ModelBinding[] = [];
  for (const raw of manifest.model?.fallbacks ?? []) {
    fallbacks.push(normalizeBinding(raw));
  }
  const promptFile = (manifest.prompt?.system ?? '').trim();
  if (!promptFile) {
    throw new Error(`agent package ${slug}: prompt.system required`);
  }
  let systemPromptRaw: string;
  try {
    systemPromptRaw = await fs.readFile(path.join(packageDir, promptFile), 'utf8');
  } catch {
    throw new Error(`agent package ${slug}: system prompt file missing (${promptFile})`);
  }
  const systemPrompt = systemPromptRaw.trim();
  if (!systemPrompt) {
    throw new Error(`agent package ${slug}: system prompt is empty`);
  }
  const asyncThreshold = manifest.behavior?.async_threshold_seconds;
  const maxRun = manifest.behavior?.max_run_seconds;
  const skills = await loadSkills(slug, packageDir, manifest.skills ?? []);
  const knowledge = await loadKnowledge(slug, packageDir, manifest.knowledge?.files ?? []);
  return {
    slug,
    name: (manifest.name ?? '').trim() || slug,
    systemPrompt,
    model: { primary, fallbacks },
    behavior: {
      asyncThresholdSeconds: Number.isFinite(asyncThreshold) ? (asyncThreshold as number) : 60,
      maxRunSeconds: Number.isFinite(maxRun) ? (maxRun as number) : 600,
    },
    skills,
    knowledge: { files: knowledge },
  };
}

/** 加载知识文件：sha256 钉定校验（LF 规范形；发布即审查）+ 大小上限（全量注入档）。 */
async function loadKnowledge(slug: string, packageDir: string, refs: KnowledgeFileRef[]): Promise<LoadedKnowledge[]> {
  const files: LoadedKnowledge[] = [];
  let totalBytes = 0;
  for (const ref of refs) {
    const rel = (ref?.path ?? '').trim();
    if (!rel) {
      throw new Error(`agent package ${slug}: knowledge file path required`);
    }
    let raw: Buffer;
    try {
      raw = await fs.readFile(path.join(packageDir, rel));
    } catch {
      throw new Error(`agent package ${slug}: knowledge file missing (${rel})`);
    }
    if (raw.byteLength > KNOWLEDGE_MAX_FILE_BYTES) {
      throw new Error(
        `agent package ${slug}: knowledge file ${rel} exceeds ${KNOWLEDGE_MAX_FILE_BYTES} bytes (use a skill for large material)`,
      );
    }
    totalBytes += raw.byteLength;
    if (totalBytes > KNOWLEDGE_MAX_TOTAL_BYTES) {
      throw new Error(`agent package ${slug}: knowledge total exceeds ${KNOWLEDGE_MAX_TOTAL_BYTES} bytes`);
    }
    const digest = crypto
      .createHash('sha256')
      .update(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
    const expected = (ref.sha256 ?? '').trim().toLowerCase();
    if (!expected) {
      throw new Error(`agent package ${slug}: knowledge ${rel} requires sha256`);
    }
    if (digest !== expected) {
      throw new Error(`agent package ${slug}: knowledge ${rel} sha256 mismatch (got ${digest})`);
    }
    files.push({ path: rel, content: raw.toString('utf8').trim() });
  }
  return files;
}

/** 加载包内 prompt 型技能（缺省约定 skills/<name>.md；引用型技能本阶段不支持）。 */
async function loadSkills(slug: string, packageDir: string, refs: SkillRef[]): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];
  for (const raw of refs) {
    if (raw?.source) {
      throw new Error(
        `agent package ${slug}: skill source "${raw.source}" not supported yet (bundle the skill file in the package instead)`,
      );
    }
    const name = (raw?.name ?? '').trim();
    if (!name) {
      throw new Error(`agent package ${slug}: skill name required`);
    }
    const rel = (raw?.path ?? `skills/${name}.md`).trim();
    let skillRaw: string;
    try {
      skillRaw = await fs.readFile(path.join(packageDir, rel), 'utf8');
    } catch {
      throw new Error(`agent package ${slug}: skill file missing (${rel})`);
    }
    const content = skillRaw.trim();
    if (!content) {
      throw new Error(`agent package ${slug}: skill ${name} is empty`);
    }
    skills.push({ name, description: (raw?.description ?? '').trim(), content });
  }
  return skills;
}
