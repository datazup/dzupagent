/**
 * generate-capability-matrix.ts
 *
 * Scans every package under packages/ and generates docs/CAPABILITY_MATRIX.md
 * with a summary table and detailed export listings.
 *
 * Usage: npx tsx scripts/generate-capability-matrix.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const OUTPUT_DIR = join(ROOT, 'docs')
const OUTPUT_FILE = join(OUTPUT_DIR, 'CAPABILITY_MATRIX.md')
const COVERAGE_FILE = join(ROOT, 'coverage-thresholds.json')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageInfo {
  dirName: string
  name: string
  description: string
  status: 'Stable' | 'Beta' | 'Alpha'
  classes: string[]
  functions: string[]
  types: string[]
  constants: string[]
}

// ---------------------------------------------------------------------------
// Status determination from coverage-thresholds.json
// ---------------------------------------------------------------------------

function loadCoverageConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(COVERAGE_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function determineStatus(
  dirName: string,
  coverageConfig: Record<string, unknown>,
): 'Stable' | 'Beta' | 'Alpha' {
  const packages = (coverageConfig.packages ?? {}) as Record<
    string,
    { thresholds?: unknown; waiver?: unknown }
  >
  const trackedPackages = (coverageConfig.trackedPackages ?? []) as string[]

  const entry = packages[dirName]

  if (entry?.waiver) return 'Beta'
  if (entry?.thresholds || trackedPackages.includes(dirName)) return 'Stable'
  return 'Alpha'
}

// ---------------------------------------------------------------------------
// Export extraction (regex-based, from src/index.ts)
// ---------------------------------------------------------------------------

function extractExports(indexPath: string): {
  classes: string[]
  functions: string[]
  types: string[]
  constants: string[]
} {
  const classes: string[] = []
  const functions: string[] = []
  const types: string[] = []
  const constants: string[] = []

  let source: string
  try {
    source = readFileSync(indexPath, 'utf-8')
  } catch {
    return { classes, functions, types, constants }
  }

  // export class Foo
  for (const m of source.matchAll(/export\s+class\s+(\w+)/g)) {
    classes.push(m[1])
  }

  // export function foo
  for (const m of source.matchAll(/export\s+function\s+(\w+)/g)) {
    functions.push(m[1])
  }

  // export const foo
  for (const m of source.matchAll(/export\s+const\s+(\w+)/g)) {
    constants.push(m[1])
  }

  // export { A, B, C } from '...'  (value exports)
  // We need to exclude lines that are `export type { ... }`
  for (const m of source.matchAll(/export\s+\{([^}]+)\}\s+from/g)) {
    // Skip if this is `export type {`
    const lineStart = source.lastIndexOf('\n', m.index) + 1
    const prefix = source.slice(lineStart, m.index).trim()
    const fullMatch = source.slice(m.index, m.index + m[0].length)
    if (fullMatch.startsWith('export type')) continue

    const items = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    for (const item of items) {
      // Skip comment lines that leaked through
      if (item.startsWith('//') || item.startsWith('/*')) continue
      // Strip trailing inline comments (e.g. "foo // comment")
      const withoutComment = item.replace(/\s*\/\/.*$/, '').trim()
      if (!withoutComment) continue
      // Handle `type X` inline annotations
      const cleaned = withoutComment.replace(/\s+as\s+\w+/, '').trim()
      if (cleaned.startsWith('type ')) {
        types.push(cleaned.replace(/^type\s+/, ''))
      } else if (/^[A-Z]/.test(cleaned)) {
        // Heuristic: PascalCase = class, camelCase = function, UPPER_CASE = constant
        if (/^[A-Z_]+$/.test(cleaned) || cleaned.includes('_')) {
          // Could be a constant like DEFAULT_RETRY_CONFIG or a schema like AgentNodeSchema
          // If it ends with Schema or contains only uppercase + underscore, treat as constant
          if (/^[A-Z][A-Z0-9_]+$/.test(cleaned)) {
            constants.push(cleaned)
          } else {
            classes.push(cleaned)
          }
        } else {
          classes.push(cleaned)
        }
      } else {
        functions.push(cleaned)
      }
    }
  }

  // export type { A, B } from '...'
  for (const m of source.matchAll(/export\s+type\s+\{([^}]+)\}/g)) {
    const items = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    for (const item of items) {
      if (item.startsWith('//') || item.startsWith('/*')) continue
      const cleaned = item.replace(/\s*\/\/.*$/, '').replace(/\s+as\s+\w+/, '').trim()
      if (cleaned) types.push(cleaned)
    }
  }

  // export interface Foo
  for (const m of source.matchAll(/export\s+interface\s+(\w+)/g)) {
    types.push(m[1])
  }

  // export type Foo = ...
  for (const m of source.matchAll(/export\s+type\s+(\w+)\s*=/g)) {
    types.push(m[1])
  }

  // Deduplicate
  return {
    classes: [...new Set(classes)],
    functions: [...new Set(functions)],
    types: [...new Set(types)],
    constants: [...new Set(constants)],
  }
}

// ---------------------------------------------------------------------------
// Fallback descriptions for packages without one in package.json
// ---------------------------------------------------------------------------

const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  agent: 'Orchestration: workflows, guardrails, tool loops, supervisor',
  'agent-types': 'Shared type definitions for the agent package',
  cache: 'LLM response caching: Redis, InMemory, middleware',
  codegen: 'Code generation: git tools, VFS, repo maps, AST',
  connectors: 'External integrations and connector implementations',
  'connectors-browser': 'Browser-oriented connector implementations',
  'connectors-documents': 'Document ingestion and connectors',
  context: 'Context management: message manager, compression, prompt cache',
  core: 'Foundation: LLM, events, plugins, MCP, security, identity',
  'create-dzupagent': 'CLI scaffolder for new DzupAgent projects',
  'domain-nl2sql': 'Domain tooling for NL2SQL pipelines and helpers',
  evals: 'Evaluation: scorers, LLM judge, benchmarks',
  'execution-ledger': 'Execution ledger for agent run tracking',
  express: 'Express adapter: SSE streaming, agent router',
  memory: 'Memory: decay, consolidation, retrieval, store factory',
  'org-domain': 'Organization domain models and utilities',
  otel: 'Observability: OpenTelemetry, tracing, metrics',
  'persona-registry': 'Persona registry for agent role management',
  playground: 'Vue 3 debug UI',
  rag: 'RAG: chunking, retrieval, context assembly, citations',
  scheduler: 'Task scheduling and execution management',
  scraper: 'Web scraping: HTTP, Puppeteer, content extraction',
  server: 'HTTP: Hono API, Drizzle, WebSocket, queue',
  testing: 'Test infra: recorder, mock models',
  'test-utils': 'Shared test utilities',
  'workflow-domain': 'Workflow domain models and definitions',
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const coverageConfig = loadCoverageConfig()

  const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  const packages: PackageInfo[] = []

  for (const dirName of packageDirs) {
    const pkgJsonPath = join(PACKAGES_DIR, dirName, 'package.json')
    const indexPath = join(PACKAGES_DIR, dirName, 'src', 'index.ts')

    let pkgJson: { name?: string; description?: string }
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    } catch {
      continue // skip directories without package.json
    }

    const name = pkgJson.name ?? dirName
    const description =
      pkgJson.description || FALLBACK_DESCRIPTIONS[dirName] || ''
    const status = determineStatus(dirName, coverageConfig)
    const exports = extractExports(indexPath)

    packages.push({
      dirName,
      name,
      description,
      status,
      ...exports,
    })
  }

  // Build markdown
  const today = new Date().toISOString().slice(0, 10)
  const lines: string[] = []

  lines.push('# DzupAgent Capability Matrix')
  lines.push('')
  lines.push(
    `Auto-generated on ${today}. Do not edit manually — run \`yarn docs:capability-matrix\`.`,
  )
  lines.push('')

  // Summary table
  lines.push('## Package Overview')
  lines.push('')
  lines.push('| Package | Description | Status | Key Exports |')
  lines.push('|---------|-------------|--------|-------------|')

  for (const pkg of packages) {
    const keyExports = [
      ...pkg.classes.slice(0, 5),
      ...pkg.functions.slice(0, 3),
    ]
    const keyStr =
      keyExports.length > 0
        ? keyExports.join(', ') +
          (pkg.classes.length + pkg.functions.length > keyExports.length
            ? ', ...'
            : '')
        : '_none exported_'
    const desc = pkg.description.replace(/\|/g, '\\|')
    lines.push(`| ${pkg.name} | ${desc} | ${pkg.status} | ${keyStr} |`)
  }

  lines.push('')

  // Detailed exports
  lines.push('## Detailed Exports')
  lines.push('')

  for (const pkg of packages) {
    const hasExports =
      pkg.classes.length +
        pkg.functions.length +
        pkg.types.length +
        pkg.constants.length >
      0

    lines.push(`### ${pkg.name}`)
    lines.push('')

    if (!hasExports) {
      lines.push('_No public exports detected in src/index.ts._')
      lines.push('')
      continue
    }

    if (pkg.classes.length > 0) {
      lines.push(`**Classes:** ${pkg.classes.join(', ')}`)
      lines.push('')
    }
    if (pkg.functions.length > 0) {
      lines.push(`**Functions:** ${pkg.functions.join(', ')}`)
      lines.push('')
    }
    if (pkg.constants.length > 0) {
      lines.push(`**Constants:** ${pkg.constants.join(', ')}`)
      lines.push('')
    }
    if (pkg.types.length > 0) {
      lines.push(`**Types:** ${pkg.types.join(', ')}`)
      lines.push('')
    }
  }

  // Write output
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf-8')

  const totalExports = packages.reduce(
    (sum, p) =>
      sum + p.classes.length + p.functions.length + p.types.length + p.constants.length,
    0,
  )
  console.log(
    `Wrote ${OUTPUT_FILE} — ${packages.length} packages, ${totalExports} exports`,
  )
}

main()
