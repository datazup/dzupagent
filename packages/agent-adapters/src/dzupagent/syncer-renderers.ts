/**
 * Provider-native file renderers and memory loader for DzupAgentSyncer.
 *
 * Split out of `syncer.ts` (MC-017). These functions are pure (no class
 * state) and convert .dzupagent/ source artifacts into provider-native
 * Markdown content.
 */

import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import type { AgentDefinition } from './agent-loader.js'
import { readFileSafe } from './syncer-state.js'

export function renderClaudeCommand(bundle: AdapterSkillBundle): string {
  const description = bundle.metadata.owner !== 'unknown'
    ? `${bundle.bundleId} (by ${bundle.metadata.owner})`
    : bundle.bundleId

  const sorted = [...bundle.promptSections].sort((a, b) => a.priority - b.priority)
  const body = sorted.map((s) => s.content).join('\n\n')

  return `---\ndescription: ${description}\n---\n\n${body}\n`
}

export function renderClaudeAgent(agent: AgentDefinition): string {
  const description = agent.description || agent.name

  return `---\ndescription: ${description}\n---\n\n${agent.personaPrompt}\n`
}

export function renderQwenCommand(bundle: AdapterSkillBundle): string {
  return renderClaudeCommand(bundle)
}

export function renderQwenAgent(agent: AgentDefinition): string {
  return renderClaudeAgent(agent)
}

export function renderInstructionsFile(
  entries: Array<{ name: string; content: string }>,
  title: string,
): string {
  const body = entries.map((e) => e.content).join('\n\n---\n\n')
  return `# ${title}\n\n${body}\n`
}

export function renderGooseHints(entries: Array<{ name: string; content: string }>): string {
  return entries.map((e) => e.content).join('\n\n---\n\n') + '\n'
}

export async function loadMemoryFiles(
  baseDir: string,
): Promise<Array<{ name: string; content: string }>> {
  const memoryDir = join(baseDir, 'memory')
  let fileNames: string[]

  try {
    fileNames = await readdir(memoryDir)
  } catch {
    return []
  }

  const mdFiles = fileNames.filter((f) => f.endsWith('.md')).sort()
  const results: Array<{ name: string; content: string }> = []

  await Promise.all(
    mdFiles.map(async (filename) => {
      const filePath = join(memoryDir, filename)
      const raw = await readFileSafe(filePath)
      if (raw === undefined) return

      // Strip YAML frontmatter: ---\n...\n---\n
      const stripped = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
      if (stripped.length === 0) return

      const name = basename(filename, extname(filename))
      results.push({ name, content: stripped })
    }),
  )

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}
