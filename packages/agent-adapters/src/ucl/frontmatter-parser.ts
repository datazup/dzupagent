/**
 * Minimal YAML-frontmatter parser for UCL `.dzupagent/*.md` files.
 *
 * Intentionally dependency-free — supports only the subset of YAML that the
 * UCL schemas (`UclSkillFrontmatter`, `UclAgentFrontmatter`,
 * `UclMemoryFrontmatter`) require:
 *   - scalar values: strings, numbers, booleans, null
 *   - flow sequences: `[a, b, c]`
 *   - nested maps (one level via 2-space indent)
 *   - block sequences under a key (lines starting with `- `)
 *
 * Missing or malformed frontmatter falls back to an empty object plus the
 * full body.
 */

/** A single frontmatter value after parsing. */
export type FrontmatterScalar = string | number | boolean | null
export type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterScalar[]
  | { [key: string]: FrontmatterValue }

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue>
  body: string
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Parse a markdown string with optional YAML frontmatter.
 * Returns the parsed frontmatter as a plain object plus the remaining body.
 */
export function parseFrontmatter(input: string): ParsedMarkdown {
  const match = FRONTMATTER_REGEX.exec(input)
  if (!match) {
    return { frontmatter: {}, body: input }
  }
  const rawFrontmatter = match[1] ?? ''
  const body = match[2] ?? ''
  const frontmatter = parseYamlBlock(rawFrontmatter)
  return { frontmatter, body }
}

/** Parse a YAML-ish block into a nested object. */
function parseYamlBlock(block: string): Record<string, FrontmatterValue> {
  const lines = block
    .split(/\r?\n/)
    .map((line) => stripComment(line))
    // keep blank lines out but keep structure lines
    .filter((line) => line.trim().length > 0)

  const root: Record<string, FrontmatterValue> = {}
  parseLines(lines, 0, 0, root)
  return root
}

/**
 * Recursive descent over indented lines.
 * Returns the index of the next line to consume at the parent level.
 */
function parseLines(
  lines: string[],
  startIndex: number,
  indent: number,
  target: Record<string, FrontmatterValue>,
): number {
  let i = startIndex
  while (i < lines.length) {
    const line = lines[i]!
    const currentIndent = countIndent(line)
    if (currentIndent < indent) {
      return i
    }
    if (currentIndent > indent) {
      // Unexpected indent at this level; skip defensively.
      i += 1
      continue
    }
    const trimmed = line.slice(currentIndent)
    if (trimmed.startsWith('- ')) {
      // Block sequence line at this indent — handled by caller via
      // parseBlockSequence, not here. Treat as terminator.
      return i
    }
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) {
      i += 1
      continue
    }
    const key = trimmed.slice(0, colonIndex).trim()
    const rest = trimmed.slice(colonIndex + 1).trim()
    if (rest.length === 0) {
      // Either a nested object or a block sequence follows on next lines.
      const next = lines[i + 1]
      if (next !== undefined) {
        const nextIndent = countIndent(next)
        const nextTrim = next.slice(nextIndent)
        if (nextIndent > indent && nextTrim.startsWith('- ')) {
          const { values, consumed } = parseBlockSequence(lines, i + 1, nextIndent)
          target[key] = values
          i = consumed
          continue
        }
        if (nextIndent > indent) {
          const child: Record<string, FrontmatterValue> = {}
          i = parseLines(lines, i + 1, nextIndent, child)
          target[key] = child
          continue
        }
      }
      target[key] = null
      i += 1
      continue
    }
    target[key] = parseScalarOrFlow(rest)
    i += 1
  }
  return i
}

function parseBlockSequence(
  lines: string[],
  startIndex: number,
  indent: number,
): { values: FrontmatterScalar[]; consumed: number } {
  const values: FrontmatterScalar[] = []
  let i = startIndex
  while (i < lines.length) {
    const line = lines[i]!
    const currentIndent = countIndent(line)
    if (currentIndent !== indent) {
      break
    }
    const trimmed = line.slice(currentIndent)
    if (!trimmed.startsWith('- ')) {
      break
    }
    const itemText = trimmed.slice(2).trim()
    const parsed = parseScalarOrFlow(itemText)
    // Block sequences in UCL schemas are always string/scalar lists.
    if (Array.isArray(parsed)) {
      // Flatten if the item itself was a flow sequence — unusual but
      // keep robust.
      for (const v of parsed) values.push(v)
    } else if (parsed !== null && typeof parsed === 'object') {
      // Nested maps in sequences are not supported by our schemas — skip.
    } else {
      values.push(parsed)
    }
    i += 1
  }
  return { values, consumed: i }
}

function parseScalarOrFlow(raw: string): FrontmatterValue {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner.length === 0) return []
    return splitFlowList(inner).map((item) => parseScalar(item.trim()))
  }
  return parseScalar(trimmed)
}

function splitFlowList(inner: string): string[] {
  const result: string[] = []
  let buffer = ''
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (const ch of inner) {
    if (inSingle) {
      buffer += ch
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      buffer += ch
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      buffer += ch
      continue
    }
    if (ch === '"') {
      inDouble = true
      buffer += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      result.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.length > 0) result.push(buffer)
  return result
}

function parseScalar(raw: string): FrontmatterScalar {
  if (raw.length === 0) return null
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null' || raw === '~') return null
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw)
  return raw
}

function countIndent(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i += 1
  return i
}

function stripComment(line: string): string {
  // Only strip full-line comments to avoid breaking strings that contain `#`.
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#')) return ''
  return line
}
