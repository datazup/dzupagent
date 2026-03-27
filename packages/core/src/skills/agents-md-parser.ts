/**
 * AGENTS.md parser — reads the emerging standard for agent configuration files.
 *
 * Supports:
 * - Top-level instructions (before any ## heading)
 * - Named sections (## Section Name)
 * - Glob-based conditional rules (## *.test.ts)
 * - Tool allow/block lists (## Tools section with - prefixed items)
 */

export interface AgentsMdConfig {
  /** Instructions to inject into agent system prompt */
  instructions: string[]
  /** Glob-based conditional rules */
  rules: Array<{ glob: string; instructions: string[] }>
  /** Tools explicitly allowed */
  allowedTools?: string[]
  /** Tools explicitly blocked */
  blockedTools?: string[]
}

const GLOB_CHARS = /[*?[\]{}]/

/**
 * Parse an AGENTS.md or CLAUDE.md file content into structured config.
 */
export function parseAgentsMd(content: string): AgentsMdConfig {
  const config: AgentsMdConfig = { instructions: [], rules: [] }

  // Split into sections by ## headings (keep content before first ## as top-level)
  const sections: Array<{ heading: string | null; body: string }> = []
  const lines = content.split('\n')
  let currentHeading: string | null = null
  let currentBody: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Save previous section
      if (currentBody.length > 0 || currentHeading !== null) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
      }
      currentHeading = line.slice(3).trim()
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }
  // Save last section
  if (currentBody.length > 0 || currentHeading !== null) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
  }

  for (const section of sections) {
    const { heading, body } = section

    // Top-level content (no heading) — always included
    if (heading === null) {
      if (body) config.instructions.push(body)
      continue
    }

    // Tools section — parse allow/block list
    if (heading.toLowerCase() === 'tools') {
      const toolLines = body.split('\n').filter(l => l.trim().startsWith('-'))
      for (const line of toolLines) {
        const tool = line.replace(/^-\s*/, '').trim()
        if (!tool) continue
        if (tool.startsWith('!')) {
          ;(config.blockedTools ??= []).push(tool.slice(1).trim())
        } else {
          ;(config.allowedTools ??= []).push(tool)
        }
      }
      continue
    }

    // Glob pattern in heading — conditional rule
    if (GLOB_CHARS.test(heading)) {
      config.rules.push({ glob: heading, instructions: body ? [body] : [] })
      continue
    }

    // Named section — add as instruction
    if (body) {
      config.instructions.push(`### ${heading}\n${body}`)
    }
  }

  return config
}

/**
 * Merge multiple AgentsMdConfig objects.
 * Later configs' instructions are appended; tool lists are merged.
 */
export function mergeAgentsMdConfigs(configs: AgentsMdConfig[]): AgentsMdConfig {
  const merged: AgentsMdConfig = { instructions: [], rules: [] }

  for (const config of configs) {
    merged.instructions.push(...config.instructions)
    merged.rules.push(...config.rules)
    if (config.allowedTools) {
      merged.allowedTools = [...(merged.allowedTools ?? []), ...config.allowedTools]
    }
    if (config.blockedTools) {
      merged.blockedTools = [...(merged.blockedTools ?? []), ...config.blockedTools]
    }
  }

  // Deduplicate tool lists
  if (merged.allowedTools) merged.allowedTools = [...new Set(merged.allowedTools)]
  if (merged.blockedTools) merged.blockedTools = [...new Set(merged.blockedTools)]

  return merged
}
