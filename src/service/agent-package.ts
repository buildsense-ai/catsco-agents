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
  version?: string;
}

export interface KnowledgeFileRef {
  path: string;
  sha256: string;
}

export interface AgentPackage {
  slug: string;
  name: string;
  systemPrompt: string;
  model: { primary: ModelBinding; fallbacks: ModelBinding[] };
  behavior: { asyncThresholdSeconds: number; maxRunSeconds: number };
  skills: SkillRef[];
  knowledge: { files: KnowledgeFileRef[] };
}

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
  return {
    slug,
    name: (manifest.name ?? '').trim() || slug,
    systemPrompt,
    model: { primary, fallbacks },
    behavior: {
      asyncThresholdSeconds: Number.isFinite(asyncThreshold) ? (asyncThreshold as number) : 60,
      maxRunSeconds: Number.isFinite(maxRun) ? (maxRun as number) : 600,
    },
    skills: manifest.skills ?? [],
    knowledge: { files: manifest.knowledge?.files ?? [] },
  };
}
