/**
 * Parser for AGENTS.md files.
 *
 * Parses a hierarchical markdown format where headings define agent sections
 * and specific fields (Role, Instructions, Tools, Constraints) provide
 * structured configuration.
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
