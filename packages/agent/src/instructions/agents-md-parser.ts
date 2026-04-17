/**
 * Parser for AGENTS.md files.
 *
 * Parses a hierarchical markdown format where headings define agent sections
 * and specific fields (Role, Instructions, Tools, Constraints) provide
 * structured configuration.
 *
 * Also provides:
 * - `mergeAgentsMd(layers)` — merge multiple parse results with precedence
 * - `discoverAgentsMdHierarchy(cwd, globalDir)` — walk filesystem for AGENTS.md files
 *
 * Example:
 * ```markdown
 * # CodeReviewer
 * Role: Reviews pull requests for quality and correctness
 * Instructions: Focus on logic errors, security issues, and performance.
 * Tools: read_file, search_code
 * Constraints: Never modify files directly
 *
 * ## StyleChecker
 * Role: Sub-agent for style enforcement
 * Instructions: Check naming conventions and formatting.
 * ```
 */

import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'

/** A parsed section from an AGENTS.md file. */
export interface AgentsMdSection {
  /** Agent identifier derived from the heading text */
  agentId: string
  /** Optional role description */
  role?: string
  /** Free-form instructions for the agent */
  instructions: string
  /** List of tool names this agent may use */
  tools?: string[]
  /** Constraints the agent must respect */
  constraints?: string[]
  /** Nested sub-agent sections (from deeper headings) */
  childSections?: AgentsMdSection[]
}

interface RawBlock {
  agentId: string
  level: number
  lines: string[]
}

/**
 * Parse an AGENTS.md string into a tree of `AgentsMdSection` nodes.
 *
 * Top-level `# Headings` produce root sections; `## Sub-headings` produce
 * children, and so on for deeper nesting.
 */
export function parseAgentsMd(content: string): AgentsMdSection[] {
  if (!content.trim()) return []

  const lines = content.split('\n')
  const blocks: RawBlock[] = []

  let current: RawBlock | null = null

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      if (current) blocks.push(current)
      const level = headingMatch[1]!.length
      const agentId = normalizeAgentId(headingMatch[2]!.trim())
      current = { agentId, level, lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
    // Lines before the first heading are ignored
  }
  if (current) blocks.push(current)

  if (blocks.length === 0) return []

  // Build the tree from the flat block list
  return buildTree(blocks)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildTree(blocks: RawBlock[]): AgentsMdSection[] {
  const roots: AgentsMdSection[] = []
  const stack: { section: AgentsMdSection; level: number }[] = []

  for (const block of blocks) {
    const section = parseBlock(block)

    // Pop stack until we find a parent with a strictly smaller level
    while (stack.length > 0 && stack[stack.length - 1]!.level >= block.level) {
      stack.pop()
    }

    if (stack.length === 0) {
      roots.push(section)
    } else {
      const parent = stack[stack.length - 1]!.section
      if (!parent.childSections) parent.childSections = []
      parent.childSections.push(section)
    }

    stack.push({ section, level: block.level })
  }

  return roots
}

function parseBlock(block: RawBlock): AgentsMdSection {
  const body = block.lines.join('\n')

  const role = extractField(body, 'Role')
  const tools = extractListField(body, 'Tools')
  const constraints = extractListField(body, 'Constraints')
  const instructions = extractInstructions(body)

  const section: AgentsMdSection = {
    agentId: block.agentId,
    instructions,
  }

  if (role) section.role = role
  if (tools && tools.length > 0) section.tools = tools
  if (constraints && constraints.length > 0) section.constraints = constraints

  return section
}

/**
 * Extract the `Instructions:` field value, or fall back to all body text
 * that isn't a recognised field.
 */
function extractInstructions(body: string): string {
  const explicit = extractField(body, 'Instructions')
  if (explicit) return explicit

  // Collect lines that aren't known fields
  const remaining = body
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (/^(Role|Tools|Constraints)\s*:/i.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()

  return remaining
}

/** Extract a single-value field like `Role: ...` */
function extractField(body: string, fieldName: string): string | undefined {
  const re = new RegExp(`^${fieldName}\\s*:\\s*(.+)$`, 'im')
  const match = re.exec(body)
  return match?.[1]?.trim() || undefined
}

/** Extract a comma-separated list field like `Tools: a, b, c` */
function extractListField(body: string, fieldName: string): string[] | undefined {
  const raw = extractField(body, fieldName)
  if (!raw) return undefined
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Normalise a heading into a kebab-case agent ID.
 * `"Code Reviewer"` -> `"code-reviewer"`
 */
function normalizeAgentId(heading: string): string {
  return heading
    // Insert hyphen before uppercase letters preceded by lowercase (camelCase split)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    // Insert hyphen between consecutive uppercase and lowercase (e.g., "HTMLParser" -> "HTML-Parser")
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge multiple AGENTS.md parse results (ordered global → project → directory).
 *
 * Later layers override earlier layers for conflicting agent IDs.
 * Array fields (tools, constraints) are merged with deduplication.
 * Scalar fields (role, instructions) from later layers replace earlier ones
 * when non-empty.
 */
export function mergeAgentsMd(layers: AgentsMdSection[][]): AgentsMdSection[] {
  if (layers.length === 0) return []
  if (layers.length === 1) return layers[0] ?? []

  // Build a map keyed by agentId; later layers override
  const merged = new Map<string, AgentsMdSection>()

  for (const layer of layers) {
    for (const section of layer) {
      const existing = merged.get(section.agentId)
      if (!existing) {
        merged.set(section.agentId, deepCloneSection(section))
      } else {
        mergeSectionInto(existing, section)
      }
    }
  }

  return Array.from(merged.values())
}

function deepCloneSection(section: AgentsMdSection): AgentsMdSection {
  const clone: AgentsMdSection = {
    agentId: section.agentId,
    instructions: section.instructions,
  }
  if (section.role !== undefined) clone.role = section.role
  if (section.tools) clone.tools = [...section.tools]
  if (section.constraints) clone.constraints = [...section.constraints]
  if (section.childSections) {
    clone.childSections = section.childSections.map(deepCloneSection)
  }
  return clone
}

/**
 * Merge `source` into `target` in-place. Source (later layer) wins for scalars.
 * Arrays are unioned with deduplication.
 */
function mergeSectionInto(target: AgentsMdSection, source: AgentsMdSection): void {
  // Scalars: later layer wins when non-empty
  if (source.role !== undefined) target.role = source.role
  if (source.instructions) target.instructions = source.instructions

  // Arrays: merge + dedupe
  if (source.tools) {
    target.tools = dedupeStrings([...(target.tools ?? []), ...source.tools])
  }
  if (source.constraints) {
    target.constraints = dedupeStrings([...(target.constraints ?? []), ...source.constraints])
  }

  // Children: recursive merge
  if (source.childSections) {
    if (!target.childSections) {
      target.childSections = source.childSections.map(deepCloneSection)
    } else {
      const childMap = new Map<string, AgentsMdSection>()
      for (const child of target.childSections) {
        childMap.set(child.agentId, child)
      }
      for (const sourceChild of source.childSections) {
        const existingChild = childMap.get(sourceChild.agentId)
        if (existingChild) {
          mergeSectionInto(existingChild, sourceChild)
        } else {
          const cloned = deepCloneSection(sourceChild)
          target.childSections.push(cloned)
          childMap.set(cloned.agentId, cloned)
        }
      }
    }
  }
}

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

// ---------------------------------------------------------------------------
// Hierarchy discovery
// ---------------------------------------------------------------------------

const AGENTS_MD_FILENAME = 'AGENTS.md'

/**
 * Discover AGENTS.md files from global directory → project root → cwd.
 *
 * Walks upward from `cwd` to the filesystem root to find all intermediate
 * AGENTS.md files. If `globalDir` is specified, its AGENTS.md is checked first.
 *
 * Returns an ordered array of parsed results suitable for `mergeAgentsMd()`.
 * Missing files are silently skipped.
 */
export async function discoverAgentsMdHierarchy(
  cwd: string,
  globalDir?: string,
): Promise<AgentsMdSection[][]> {
  const layers: AgentsMdSection[][] = []
  const resolvedCwd = resolve(cwd)

  // 1. Global config dir (e.g. ~/.config/dzupagent/)
  if (globalDir) {
    const globalResult = await tryParseAgentsMdAt(resolve(globalDir))
    if (globalResult) layers.push(globalResult)
  }

  // 2. Walk from filesystem root down to cwd (collect intermediate AGENTS.md)
  const ancestors = getAncestorDirs(resolvedCwd)
  // ancestors is ordered from root → cwd, so earlier = higher level
  for (const dir of ancestors) {
    // Skip globalDir if it was already processed
    if (globalDir && resolve(globalDir) === dir) continue
    const result = await tryParseAgentsMdAt(dir)
    if (result) layers.push(result)
  }

  return layers
}

/**
 * Get ancestor directories from root down to (and including) the target dir.
 * Returns them in root-first order.
 */
function getAncestorDirs(dir: string): string[] {
  const dirs: string[] = []
  let current = dir
  const seen = new Set<string>()

  while (!seen.has(current)) {
    seen.add(current)
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break // reached root
    current = parent
  }

  // Reverse so root is first, cwd is last
  dirs.reverse()
  return dirs
}

/**
 * Try to read and parse AGENTS.md in the given directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function tryParseAgentsMdAt(dir: string): Promise<AgentsMdSection[] | null> {
  try {
    const filePath = join(dir, AGENTS_MD_FILENAME)
    const content = await readFile(filePath, 'utf-8')
    const sections = parseAgentsMd(content)
    // Return null for empty results so they are skipped
    return sections.length > 0 ? sections : null
  } catch {
    // File doesn't exist or isn't readable — silently skip
    return null
  }
}
