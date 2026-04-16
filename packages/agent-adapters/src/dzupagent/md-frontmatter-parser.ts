/**
 * Minimal YAML-frontmatter + Markdown section parser.
 *
 * Supports the subset of YAML used in .dzupagent/ files:
 *   - String scalars:  key: value
 *   - Numbers:         version: 1
 *   - Booleans:        active: true
 *   - Inline arrays:   tags: [foo, bar]
 *   - Block arrays:    tools:\n  required: [a, b]
 *   - Nested objects:  constraints:\n  maxBudgetUsd: 0.5
 *
 * Limitations (intentional — not needed for our frontmatter):
 *   - No multi-line strings
 *   - No anchors/aliases
 *   - No complex nested arrays
 *   - Only one level of nesting supported in nested objects
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FrontmatterScalar = string | number | boolean | string[] | undefined
export type FrontmatterNested = Record<string, FrontmatterScalar>
export type FrontmatterValue = FrontmatterScalar | FrontmatterNested

export type ParsedFrontmatter = Record<string, FrontmatterValue>

export interface ParsedSection {
  /** The heading text, e.g. "Persona" (without ## prefix) */
  heading: string
  /** Trimmed content of the section */
  content: string
}

export interface ParsedMarkdownFile {
  frontmatter: ParsedFrontmatter
  /** Parsed ## heading sections from the body */
  sections: ParsedSection[]
  /** Everything after the closing --- of frontmatter */
  rawBody: string
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a .md file with YAML frontmatter and ## heading sections.
 *
 * @param content - Raw file content as a string
 */
export function parseMarkdownFile(content: string): ParsedMarkdownFile {
  const { frontmatter, body } = splitFrontmatter(content)
  const parsedFrontmatter = parseFrontmatter(frontmatter)
  const sections = parseSections(body)

  return {
    frontmatter: parsedFrontmatter,
    sections,
    rawBody: body,
  }
}

// ---------------------------------------------------------------------------
// Frontmatter splitting
// ---------------------------------------------------------------------------

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const lines = content.split('\n')

  // Must start with --- (ignoring leading blank lines)
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start++

  if (start >= lines.length || lines[start]!.trim() !== '---') {
    return { frontmatter: '', body: content }
  }

  // Find closing ---
  let end = start + 1
  while (end < lines.length && lines[end]!.trim() !== '---') {
    end++
  }

  if (end >= lines.length) {
    // No closing --- found — treat entire content as body
    return { frontmatter: '', body: content }
  }

  const frontmatter = lines.slice(start + 1, end).join('\n')
  const body = lines.slice(end + 1).join('\n').trimStart()

  return { frontmatter, body }
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(yaml: string): ParsedFrontmatter {
  if (!yaml.trim()) return {}

  const result: ParsedFrontmatter = {}
  const lines = yaml.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }

    // Top-level key: value pair
    const topMatch = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line)
    if (!topMatch) {
      i++
      continue
    }

    const key = topMatch[1]!
    const rawValue = topMatch[2]!.trim()

    if (rawValue === '' || rawValue === null) {
      // Could be a nested object or block array — look at indented next lines
      i++
      const nested = collectIndented(lines, i)
      if (nested.length > 0) {
        result[key] = parseNestedObject(nested)
        i += nested.length
      } else {
        result[key] = undefined
      }
    } else {
      result[key] = parseScalar(rawValue)
      i++
    }
  }

  return result
}

/** Collect lines indented relative to a top-level key (2+ spaces). */
function collectIndented(lines: string[], startIdx: number): string[] {
  const collected: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^\s{2,}/.test(line)) {
      collected.push(line)
    } else {
      break
    }
  }
  return collected
}

/** Parse indented block (one-level nested object or block sequences). */
function parseNestedObject(lines: string[]): FrontmatterNested {
  const obj: FrontmatterNested = {}
  for (const line of lines) {
    const match = /^\s+([a-zA-Z_][\w-]*):\s*(.+)$/.exec(line)
    if (match) {
      obj[match[1]!] = parseScalar(match[2]!.trim())
    }
  }
  return obj
}

/** Parse a scalar YAML value: string, number, boolean, or inline array. */
function parseScalar(raw: string): FrontmatterScalar {
  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1)
    if (!inner.trim()) return []
    return inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0)
  }

  // Boolean
  if (raw === 'true') return true
  if (raw === 'false') return false

  // Null/undefined indicators
  if (raw === 'null' || raw === '~' || raw === '') return undefined

  // Number
  const num = Number(raw)
  if (!isNaN(num) && raw !== '') return num

  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }

  // Plain string (strip inline comments)
  const commentIdx = raw.indexOf(' #')
  if (commentIdx > 0) return raw.slice(0, commentIdx).trimEnd()

  return raw
}

// ---------------------------------------------------------------------------
// Section parser
// ---------------------------------------------------------------------------

/**
 * Split markdown body by `## Heading` markers.
 * Returns sections with their heading and trimmed content.
 */
function parseSections(body: string): ParsedSection[] {
  const sections: ParsedSection[] = []
  // Match ## headings (but not ### or deeper)
  const headingRegex = /^## ([^\n]+)/gm

  let lastIndex = 0
  let lastHeading: string | null = null
  let match: RegExpExecArray | null

  // Collect content before first heading (if any)
  const firstMatch = headingRegex.exec(body)
  if (firstMatch) {
    // Reset and iterate properly
    headingRegex.lastIndex = 0
  }

  const parts: Array<{ heading: string | null; start: number; end: number }> = []

  // Find all heading positions
  const headings: Array<{ heading: string; index: number }> = []
  headingRegex.lastIndex = 0
  while ((match = headingRegex.exec(body)) !== null) {
    headings.push({ heading: match[1]!.trim(), index: match.index })
  }

  if (headings.length === 0) {
    // No sections — body is just content
    return []
  }

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!
    const next = headings[i + 1]

    // Start of section content = after the heading line
    const headingLineEnd = body.indexOf('\n', current.index)
    const contentStart = headingLineEnd === -1 ? body.length : headingLineEnd + 1
    const contentEnd = next !== undefined ? next.index : body.length

    const content = body.slice(contentStart, contentEnd).trim()
    sections.push({ heading: current.heading, content })
  }

  void parts
  void lastIndex
  void lastHeading

  return sections
}
