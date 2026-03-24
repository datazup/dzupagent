/**
 * Output format adapters — validate and detect content formats.
 */

export type OutputFormat =
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'html'
  | 'mermaid'
  | 'openapi'
  | 'prisma'
  | 'sql'
  | 'plain'

export interface FormatValidationResult {
  valid: boolean
  errors: string[]
}

export interface FormatAdapter {
  format: OutputFormat
  /** Validate that content matches expected format */
  validate(content: string): FormatValidationResult
  /** Extract structured data from formatted content */
  extract(content: string): unknown
}

function createAdapter(
  format: OutputFormat,
  validate: (content: string) => FormatValidationResult,
  extract: (content: string) => unknown = () => null,
): FormatAdapter {
  return { format, validate, extract }
}

const jsonAdapter = createAdapter(
  'json',
  (content) => {
    try {
      JSON.parse(content)
      return { valid: true, errors: [] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON'
      return { valid: false, errors: [msg] }
    }
  },
  (content) => {
    try {
      return JSON.parse(content) as unknown
    } catch {
      return null
    }
  },
)

const yamlAdapter = createAdapter('yaml', (content) => {
  const trimmed = content.trim()
  if (trimmed.length === 0) return { valid: false, errors: ['Empty content'] }
  const hasKeyValue = /^[\w][\w\s]*:\s*.+/m.test(trimmed)
  const hasDashList = /^-\s+.+/m.test(trimmed)
  const hasDocMarker = trimmed.startsWith('---')
  if (hasKeyValue || hasDashList || hasDocMarker) return { valid: true, errors: [] }
  return { valid: false, errors: ['No YAML key-value pairs, list items, or document markers found'] }
})

const markdownAdapter = createAdapter('markdown', (content) => {
  const trimmed = content.trim()
  if (trimmed.length === 0) return { valid: false, errors: ['Empty content'] }
  const hasHeading = /^#{1,6}\s+.+/m.test(trimmed)
  const hasList = /^[\s]*[-*+]\s+.+/m.test(trimmed)
  const hasCodeBlock = /```[\s\S]*?```/.test(trimmed)
  const hasLink = /\[.+?\]\(.+?\)/.test(trimmed)
  if (hasHeading || hasList || hasCodeBlock || hasLink) return { valid: true, errors: [] }
  return { valid: false, errors: ['No markdown headings, lists, code blocks, or links found'] }
})

const htmlAdapter = createAdapter('html', (content) => {
  const trimmed = content.trim()
  if (trimmed.length === 0) return { valid: false, errors: ['Empty content'] }
  const hasTag = /<[a-zA-Z][^>]*>/.test(trimmed)
  if (hasTag) return { valid: true, errors: [] }
  return { valid: false, errors: ['No HTML tags found'] }
})

const mermaidAdapter = createAdapter('mermaid', (content) => {
  const trimmed = content.trim()
  const keywords = ['graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gantt', 'pie', 'gitgraph']
  const found = keywords.some((kw) => trimmed.startsWith(kw))
  if (found) return { valid: true, errors: [] }
  return { valid: false, errors: ['Content does not start with a known Mermaid diagram keyword'] }
})

const plainAdapter = createAdapter('plain', () => ({ valid: true, errors: [] }))

const openapiAdapter = createAdapter('openapi', (content) => {
  const trimmed = content.trim()
  const hasOpenapi = /openapi\s*:\s*["']?\d/.test(trimmed) || /"openapi"\s*:\s*"/.test(trimmed)
  if (hasOpenapi) return { valid: true, errors: [] }
  return { valid: false, errors: ['No OpenAPI version declaration found'] }
})

const prismaAdapter = createAdapter('prisma', (content) => {
  const trimmed = content.trim()
  const hasModel = /^model\s+\w+\s*\{/m.test(trimmed)
  const hasGenerator = /^generator\s+\w+\s*\{/m.test(trimmed)
  const hasDatasource = /^datasource\s+\w+\s*\{/m.test(trimmed)
  if (hasModel || hasGenerator || hasDatasource) return { valid: true, errors: [] }
  return { valid: false, errors: ['No Prisma model, generator, or datasource blocks found'] }
})

const sqlAdapter = createAdapter('sql', (content) => {
  const upper = content.trim().toUpperCase()
  const keywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'BEGIN', 'COMMIT']
  const found = keywords.some((kw) => upper.startsWith(kw) || new RegExp(`\\b${kw}\\b`).test(upper))
  if (found) return { valid: true, errors: [] }
  return { valid: false, errors: ['No SQL keywords found'] }
})

/** Built-in format validators */
export const FORMAT_ADAPTERS: Record<string, FormatAdapter> = {
  json: jsonAdapter,
  yaml: yamlAdapter,
  markdown: markdownAdapter,
  html: htmlAdapter,
  mermaid: mermaidAdapter,
  openapi: openapiAdapter,
  prisma: prismaAdapter,
  sql: sqlAdapter,
  plain: plainAdapter,
}

/** Validate content against an expected format */
export function validateFormat(content: string, format: OutputFormat): FormatValidationResult {
  const adapter = FORMAT_ADAPTERS[format]
  if (!adapter) return { valid: false, errors: [`Unknown format: ${format}`] }
  return adapter.validate(content)
}

/** Detect the format of content (tries specific formats first, falls back to plain) */
export function detectFormat(content: string): OutputFormat {
  const trimmed = content.trim()

  // Try JSON first (unambiguous)
  try {
    JSON.parse(trimmed)
    return 'json'
  } catch {
    // not JSON
  }

  // Order matters: more specific formats first
  const checks: OutputFormat[] = ['mermaid', 'openapi', 'prisma', 'html', 'sql', 'yaml', 'markdown']
  for (const fmt of checks) {
    const adapter = FORMAT_ADAPTERS[fmt]
    if (adapter && adapter.validate(trimmed).valid) return fmt
  }

  return 'plain'
}
