/**
 * Merges static agent instructions with AGENTS.md hierarchy.
 *
 * The merger combines a base system prompt (the `instructions` field from
 * ForgeAgentConfig) with structured sections parsed from AGENTS.md files
 * to produce a single unified system prompt.
 */

import type { AgentsMdSection } from './agents-md-parser.js'

/** Result of merging instructions from multiple sources. */
export interface MergedInstructions {
  /** The final system prompt text ready for LLM consumption */
  systemPrompt: string
  /** Full agent hierarchy from AGENTS.md files */
  agentHierarchy: AgentsMdSection[]
  /** File paths that contributed to the merged output */
  sources: string[]
}

/**
 * Merge static instructions with AGENTS.md sections.
 *
 * @param staticInstructions - The base system prompt from ForgeAgentConfig.instructions
 * @param agentsSections - Parsed AGENTS.md sections (may span multiple files)
 * @param agentId - When provided, only sections matching this ID (or its
 *   ancestors) are included. If omitted, all sections are rendered.
 * @param sources - Optional file paths that produced the sections
 */
export function mergeInstructions(
  staticInstructions: string,
  agentsSections: AgentsMdSection[],
  agentId?: string,
  sources?: string[],
): MergedInstructions {
  const relevantSections = agentId
    ? filterSectionsForAgent(agentsSections, agentId)
    : agentsSections

  const parts: string[] = [staticInstructions]

  if (relevantSections.length > 0) {
    parts.push('')
    parts.push('## Agent Configuration (from AGENTS.md)')
    parts.push('')
    for (const section of relevantSections) {
      parts.push(renderSection(section, 0))
    }
  }

  return {
    systemPrompt: parts.join('\n'),
    agentHierarchy: agentsSections,
    sources: sources ?? [],
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Filter sections to only include the subtree relevant to `agentId`.
 *
 * Returns sections that either match `agentId` directly or contain a
 * descendant matching it. When a section matches directly, its full subtree
 * (including children) is preserved.
 */
function filterSectionsForAgent(
  sections: AgentsMdSection[],
  agentId: string,
): AgentsMdSection[] {
  const result: AgentsMdSection[] = []

  for (const section of sections) {
    if (section.agentId === agentId) {
      // Exact match: include this section and all children
      result.push(section)
    } else if (section.childSections && containsAgent(section.childSections, agentId)) {
      // This section contains the target as a descendant — include the
      // parent context plus filtered children
      const filtered: AgentsMdSection = {
        ...section,
        childSections: filterSectionsForAgent(section.childSections, agentId),
      }
      result.push(filtered)
    }
  }

  return result
}

/** Check whether any section in the tree has the given agentId. */
function containsAgent(sections: AgentsMdSection[], agentId: string): boolean {
  for (const s of sections) {
    if (s.agentId === agentId) return true
    if (s.childSections && containsAgent(s.childSections, agentId)) return true
  }
  return false
}

/** Render a section and its children as formatted text. */
function renderSection(section: AgentsMdSection, depth: number): string {
  const indent = '  '.repeat(depth)
  const lines: string[] = []

  lines.push(`${indent}### ${section.agentId}`)
  if (section.role) {
    lines.push(`${indent}**Role:** ${section.role}`)
  }
  if (section.instructions) {
    lines.push(`${indent}${section.instructions}`)
  }
  if (section.tools && section.tools.length > 0) {
    lines.push(`${indent}**Tools:** ${section.tools.join(', ')}`)
  }
  if (section.constraints && section.constraints.length > 0) {
    lines.push(`${indent}**Constraints:**`)
    for (const c of section.constraints) {
      lines.push(`${indent}- ${c}`)
    }
  }

  if (section.childSections) {
    lines.push('')
    for (const child of section.childSections) {
      lines.push(renderSection(child, depth + 1))
    }
  }

  lines.push('')
  return lines.join('\n')
}
