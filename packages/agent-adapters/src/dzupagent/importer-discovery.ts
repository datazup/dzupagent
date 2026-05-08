/**
 * Discovery and source-type inference helpers for DzupAgentImporter.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { DzupAgentPaths } from '@dzupagent/adapter-types'
import type { ImportSource } from './importer-types.js'

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** List *.md files in a directory. Returns empty array if dir doesn't exist. */
export async function globMdFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath)
    return entries.filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/**
 * Discover all importable native agent files relative to a project root.
 * Returns list of ImportSource → targetPath candidate pairs.
 */
export async function discoverImportCandidates(
  projectRoot: string,
  paths: DzupAgentPaths,
): Promise<Array<{ source: ImportSource; targetPath: string }>> {
  const candidates: Array<{ source: ImportSource; targetPath: string }> = []
  const projectDir = paths.projectDir

  // CLAUDE.md
  const claudeMd = join(projectRoot, 'CLAUDE.md')
  if (await fileExists(claudeMd)) {
    candidates.push({
      source: { type: 'claude-md', sourcePath: claudeMd },
      targetPath: join(projectDir, 'memory', 'claude-project-context.md'),
    })
  }

  // AGENTS.md
  const agentsMd = join(projectRoot, 'AGENTS.md')
  if (await fileExists(agentsMd)) {
    candidates.push({
      source: { type: 'codex-agents-md', sourcePath: agentsMd },
      targetPath: join(projectDir, 'memory', 'codex-project-context.md'),
    })
  }

  // .claude/commands/*.md
  const commandsDir = join(projectRoot, '.claude', 'commands')
  const commandFiles = await globMdFiles(commandsDir)
  for (const file of commandFiles) {
    const name = basename(file, '.md')
    candidates.push({
      source: { type: 'claude-commands', sourcePath: join(commandsDir, file) },
      targetPath: join(projectDir, 'skills', `${name}.md`),
    })
  }

  // .claude/agents/*.md
  const agentsDir = join(projectRoot, '.claude', 'agents')
  const agentFiles = await globMdFiles(agentsDir)
  for (const file of agentFiles) {
    const name = basename(file, '.md')
    candidates.push({
      source: { type: 'claude-agents', sourcePath: join(agentsDir, file) },
      targetPath: join(projectDir, 'agents', `${name}.md`),
    })
  }

  // .claude/memory/*.md
  const memoryDir = join(projectRoot, '.claude', 'memory')
  const memoryFiles = await globMdFiles(memoryDir)
  for (const file of memoryFiles) {
    const name = basename(file, '.md')
    candidates.push({
      source: { type: 'claude-memory', sourcePath: join(memoryDir, file) },
      targetPath: join(projectDir, 'memory', `${name}.md`),
    })
  }

  // GEMINI.md
  const geminiMd = join(projectRoot, 'GEMINI.md')
  if (await fileExists(geminiMd)) {
    candidates.push({
      source: { type: 'gemini-md', sourcePath: geminiMd },
      targetPath: join(projectDir, 'memory', 'gemini-project-context.md'),
    })
  }

  // .gemini/settings.json
  const geminiSettings = join(projectRoot, '.gemini', 'settings.json')
  if (await fileExists(geminiSettings)) {
    candidates.push({
      source: { type: 'gemini-settings', sourcePath: geminiSettings },
      targetPath: join(projectDir, 'memory', 'gemini-settings.json'),
    })
  }

  // QWEN.md
  const qwenMd = join(projectRoot, 'QWEN.md')
  if (await fileExists(qwenMd)) {
    candidates.push({
      source: { type: 'qwen-md', sourcePath: qwenMd },
      targetPath: join(projectDir, 'memory', 'qwen-project-context.md'),
    })
  }

  // .qwen/skills/*.md
  const qwenSkillsDir = join(projectRoot, '.qwen', 'skills')
  const qwenSkillFiles = await globMdFiles(qwenSkillsDir)
  for (const file of qwenSkillFiles) {
    const name = basename(file, '.md')
    candidates.push({
      source: { type: 'qwen-skills', sourcePath: join(qwenSkillsDir, file) },
      targetPath: join(projectDir, 'skills', `${name}.md`),
    })
  }

  // .qwen/agents/*.md
  const qwenAgentsDir = join(projectRoot, '.qwen', 'agents')
  const qwenAgentFiles = await globMdFiles(qwenAgentsDir)
  for (const file of qwenAgentFiles) {
    const name = basename(file, '.md')
    candidates.push({
      source: { type: 'qwen-agents', sourcePath: join(qwenAgentsDir, file) },
      targetPath: join(projectDir, 'agents', `${name}.md`),
    })
  }

  // .goosehints
  const gooseHints = join(projectRoot, '.goosehints')
  if (await fileExists(gooseHints)) {
    candidates.push({
      source: { type: 'goose-hints', sourcePath: gooseHints },
      targetPath: join(projectDir, 'memory', 'goose-hints.md'),
    })
  }

  // .crush/skills/*.md
  const crushSkillsDir = join(projectRoot, '.crush', 'skills')
  const crushSkillFiles = await globMdFiles(crushSkillsDir)
  for (const file of crushSkillFiles) {
    const name = basename(file, '.md')
    candidates.push({
      source: { type: 'crush-skills', sourcePath: join(crushSkillsDir, file) },
      targetPath: join(projectDir, 'skills', `${name}.md`),
    })
  }

  return candidates
}

/**
 * Infer the ImportSource type from a previously-imported source file path.
 * Used during divergence detection to re-classify state-tracked files.
 */
export function inferSourceType(sourcePath: string): ImportSource | undefined {
  if (sourcePath.endsWith('CLAUDE.md') && !sourcePath.includes('.claude')) {
    return { type: 'claude-md', sourcePath }
  }
  if (sourcePath.endsWith('AGENTS.md')) {
    return { type: 'codex-agents-md', sourcePath }
  }
  if (sourcePath.includes('.claude/commands/')) {
    return { type: 'claude-commands', sourcePath }
  }
  if (sourcePath.includes('.claude/agents/')) {
    return { type: 'claude-agents', sourcePath }
  }
  if (sourcePath.includes('.claude/memory/')) {
    return { type: 'claude-memory', sourcePath }
  }
  if (sourcePath.endsWith('GEMINI.md')) {
    return { type: 'gemini-md', sourcePath }
  }
  if (sourcePath.includes('.gemini/settings.json')) {
    return { type: 'gemini-settings', sourcePath }
  }
  if (sourcePath.endsWith('QWEN.md')) {
    return { type: 'qwen-md', sourcePath }
  }
  if (sourcePath.includes('.qwen/skills/')) {
    return { type: 'qwen-skills', sourcePath }
  }
  if (sourcePath.includes('.qwen/agents/')) {
    return { type: 'qwen-agents', sourcePath }
  }
  if (sourcePath.endsWith('.goosehints')) {
    return { type: 'goose-hints', sourcePath }
  }
  if (sourcePath.includes('.crush/skills/')) {
    return { type: 'crush-skills', sourcePath }
  }
  return undefined
}
