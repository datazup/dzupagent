/**
 * Content transformation helpers for DzupAgentImporter.
 *
 * Wraps native agent files (CLAUDE.md, AGENTS.md, etc.) with the YAML
 * frontmatter expected by the .dzupagent/ projection format.
 */

import { basename } from 'node:path'
import { parseMarkdownFile } from './md-frontmatter-parser.js'
import type { ImportSource } from './importer-types.js'

/**
 * Wrap raw content with a full frontmatter block (no existing frontmatter expected).
 */
function wrapWithFrontmatter(
  content: string,
  fields: Record<string, string>,
): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${content}`
}

/**
 * Insert new fields into existing YAML frontmatter.
 * Only adds fields that are not already present.
 */
function insertIntoExistingFrontmatter(
  content: string,
  fields: Record<string, string>,
): string {
  const lines = content.split('\n')

  // Find the opening and closing ---
  let openIdx = -1
  let closeIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      if (openIdx === -1) {
        openIdx = i
      } else {
        closeIdx = i
        break
      }
    }
  }

  if (openIdx === -1 || closeIdx === -1) {
    // Shouldn't happen if hasFrontmatter is true, but be safe
    return content
  }

  // Extract existing frontmatter lines
  const fmLines = lines.slice(openIdx + 1, closeIdx)

  // Check which fields already exist
  const existingKeys = new Set<string>()
  for (const line of fmLines) {
    const match = /^([a-zA-Z_][\w-]*):\s*/.exec(line)
    if (match) existingKeys.add(match[1]!)
  }

  // Add missing fields
  const newLines: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (!existingKeys.has(key)) {
      newLines.push(`${key}: ${value}`)
    }
  }

  if (newLines.length === 0) return content

  // Insert new lines before the closing ---
  const result = [
    ...lines.slice(0, closeIdx),
    ...newLines,
    ...lines.slice(closeIdx),
  ]

  return result.join('\n')
}

/**
 * If file already has frontmatter, add `importedFrom` (and other missing fields).
 * If no frontmatter, create a new frontmatter block.
 */
function addOrCreateFrontmatter(
  content: string,
  fields: Record<string, string>,
): string {
  const parsed = parseMarkdownFile(content)
  const hasFrontmatter = Object.keys(parsed.frontmatter).length > 0

  if (hasFrontmatter) {
    // Insert importedFrom into existing frontmatter
    return insertIntoExistingFrontmatter(content, fields)
  }

  // No frontmatter — wrap with new block
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${content}`
}

/**
 * Transform raw source content into the canonical .dzupagent/ format
 * by injecting appropriate frontmatter for the source type.
 */
export function transformImportContent(source: ImportSource, rawContent: string): string {
  switch (source.type) {
    case 'claude-md':
      return wrapWithFrontmatter(rawContent, {
        name: 'claude-project-context',
        description: 'Claude project context imported from CLAUDE.md',
        type: 'project',
        importedFrom: 'CLAUDE.md',
      })

    case 'codex-agents-md':
      return wrapWithFrontmatter(rawContent, {
        name: 'codex-project-context',
        description: 'Codex project context imported from AGENTS.md',
        type: 'project',
        importedFrom: 'AGENTS.md',
      })

    case 'claude-commands': {
      const name = basename(source.sourcePath, '.md')
      const relativePath = `.claude/commands/${basename(source.sourcePath)}`
      return addOrCreateFrontmatter(rawContent, {
        name,
        description: `Imported from ${relativePath}`,
        importedFrom: relativePath,
      })
    }

    case 'claude-agents': {
      const name = basename(source.sourcePath, '.md')
      const relativePath = `.claude/agents/${basename(source.sourcePath)}`
      return addOrCreateFrontmatter(rawContent, {
        name,
        description: `Imported from ${relativePath}`,
        importedFrom: relativePath,
      })
    }

    case 'claude-memory': {
      const name = basename(source.sourcePath, '.md')
      const relativePath = `.claude/memory/${basename(source.sourcePath)}`
      return addOrCreateFrontmatter(rawContent, {
        name,
        description: 'Claude agent-specific memory',
        type: 'agent',
        importedFrom: relativePath,
      })
    }

    case 'gemini-md':
      return wrapWithFrontmatter(rawContent, {
        name: 'gemini-project-context',
        description: 'Gemini project context imported from GEMINI.md',
        type: 'project',
        importedFrom: 'GEMINI.md',
      })

    case 'gemini-settings': {
      const wrapped = `\`\`\`json\n${rawContent}\n\`\`\``
      return wrapWithFrontmatter(wrapped, {
        name: 'gemini-settings',
        description: 'Gemini settings imported from .gemini/settings.json',
        type: 'config',
        importedFrom: '.gemini/settings.json',
      })
    }

    case 'qwen-md':
      return wrapWithFrontmatter(rawContent, {
        name: 'qwen-project-context',
        description: 'Qwen project context imported from QWEN.md',
        type: 'project',
        importedFrom: 'QWEN.md',
      })

    case 'qwen-skills': {
      const name = basename(source.sourcePath, '.md')
      const relativePath = `.qwen/skills/${basename(source.sourcePath)}`
      return addOrCreateFrontmatter(rawContent, {
        name,
        description: `Imported from ${relativePath}`,
        importedFrom: relativePath,
      })
    }

    case 'qwen-agents': {
      const name = basename(source.sourcePath, '.md')
      const relativePath = `.qwen/agents/${basename(source.sourcePath)}`
      return addOrCreateFrontmatter(rawContent, {
        name,
        description: `Imported from ${relativePath}`,
        importedFrom: relativePath,
      })
    }

    case 'goose-hints':
      return wrapWithFrontmatter(rawContent, {
        name: 'goose-hints',
        description: 'Goose hints imported from .goosehints',
        type: 'project',
        importedFrom: '.goosehints',
      })

    case 'crush-skills': {
      const name = basename(source.sourcePath, '.md')
      const relativePath = `.crush/skills/${basename(source.sourcePath)}`
      return addOrCreateFrontmatter(rawContent, {
        name,
        description: `Imported from ${relativePath}`,
        importedFrom: relativePath,
      })
    }
  }
}
