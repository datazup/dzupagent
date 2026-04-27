#!/usr/bin/env node
/**
 * Scans every package under packages/ and generates docs/CAPABILITY_MATRIX.md
 * with a summary table and detailed export listings.
 *
 * Usage: node scripts/generate-capability-matrix.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

function loadCoverageConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'coverage-thresholds.json'), 'utf-8'))
  } catch {
    return {}
  }
}

function determineStatus(dirName, coverageConfig) {
  const packages = coverageConfig.packages ?? {}
  const trackedPackages = coverageConfig.trackedPackages ?? []
  const entry = packages[dirName]

  if (entry?.waiver) return 'Beta'
  if (entry?.thresholds || trackedPackages.includes(dirName)) return 'Stable'
  return 'Alpha'
}

function extractExports(indexPath) {
  const classes = []
  const functions = []
  const types = []
  const constants = []

  let source
  try {
    source = readFileSync(indexPath, 'utf-8')
  } catch {
    return { classes, functions, types, constants }
  }

  for (const m of source.matchAll(/export\s+class\s+(\w+)/g)) {
    classes.push(m[1])
  }

  for (const m of source.matchAll(/export\s+function\s+(\w+)/g)) {
    functions.push(m[1])
  }

  for (const m of source.matchAll(/export\s+const\s+(\w+)/g)) {
    constants.push(m[1])
  }

  for (const m of source.matchAll(/export\s+\{([^}]+)\}\s+from/g)) {
    const fullMatch = source.slice(m.index, m.index + m[0].length)
    if (fullMatch.startsWith('export type')) continue

    const items = m[1].split(',').map((value) => value.trim()).filter(Boolean)
    for (const item of items) {
      if (item.startsWith('//') || item.startsWith('/*')) continue
      const withoutComment = item.replace(/\s*\/\/.*$/, '').trim()
      if (!withoutComment) continue
      const cleaned = withoutComment.replace(/\s+as\s+\w+/, '').trim()
      if (cleaned.startsWith('type ')) {
        types.push(cleaned.replace(/^type\s+/, ''))
      } else if (/^[A-Z]/.test(cleaned)) {
        if (/^[A-Z_]+$/.test(cleaned) || cleaned.includes('_')) {
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

  for (const m of source.matchAll(/export\s+type\s+\{([^}]+)\}/g)) {
    const items = m[1].split(',').map((value) => value.trim()).filter(Boolean)
    for (const item of items) {
      if (item.startsWith('//') || item.startsWith('/*')) continue
      const cleaned = item.replace(/\s*\/\/.*$/, '').replace(/\s+as\s+\w+/, '').trim()
      if (cleaned) types.push(cleaned)
    }
  }

  for (const m of source.matchAll(/export\s+interface\s+(\w+)/g)) {
    types.push(m[1])
  }

  for (const m of source.matchAll(/export\s+type\s+(\w+)\s*=/g)) {
    types.push(m[1])
  }

  return {
    classes: [...new Set(classes)],
    functions: [...new Set(functions)],
    types: [...new Set(types)],
    constants: [...new Set(constants)],
  }
}

const FALLBACK_DESCRIPTIONS = {
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
  rag: 'RAG: chunking, retrieval, context assembly, citations',
  scheduler: 'Task scheduling and execution management',
  scraper: 'Web scraping: HTTP, Puppeteer, content extraction',
  server: 'HTTP: Hono API, Drizzle, WebSocket, queue',
  testing: 'Test infra: recorder, mock models',
  'test-utils': 'Shared test utilities',
  'workflow-domain': 'Workflow domain models and definitions',
}

export function generateCapabilityMatrix(root = DEFAULT_ROOT) {
  const packagesDir = join(root, 'packages')
  const outputDir = join(root, 'docs')
  const outputFile = join(outputDir, 'CAPABILITY_MATRIX.md')
  const coverageConfig = loadCoverageConfig(root)

  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const packages = []

  for (const dirName of packageDirs) {
    const pkgJsonPath = join(packagesDir, dirName, 'package.json')
    const indexPath = join(packagesDir, dirName, 'src', 'index.ts')

    let pkgJson
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    } catch {
      continue
    }

    const name = pkgJson.name ?? dirName
    const description = pkgJson.description || FALLBACK_DESCRIPTIONS[dirName] || ''

    packages.push({
      dirName,
      name,
      description,
      status: determineStatus(dirName, coverageConfig),
      ...extractExports(indexPath),
    })
  }

  const today = new Date().toISOString().slice(0, 10)
  const lines = []

  lines.push('# DzupAgent Capability Matrix')
  lines.push('')
  lines.push(
    `Auto-generated on ${today}. Do not edit manually — run \`yarn docs:capability-matrix\`.`,
  )
  lines.push('')
  lines.push('## Package Overview')
  lines.push('')
  lines.push('| Package | Description | Status | Key Exports |')
  lines.push('|---------|-------------|--------|-------------|')

  for (const pkg of packages) {
    const keyExports = [...pkg.classes.slice(0, 5), ...pkg.functions.slice(0, 3)]
    const keyStr =
      keyExports.length > 0
        ? keyExports.join(', ') +
          (pkg.classes.length + pkg.functions.length > keyExports.length ? ', ...' : '')
        : '_none exported_'
    const desc = pkg.description.replace(/\|/g, '\\|')
    lines.push(`| ${pkg.name} | ${desc} | ${pkg.status} | ${keyStr} |`)
  }

  lines.push('')
  lines.push('## Detailed Exports')
  lines.push('')

  for (const pkg of packages) {
    const hasExports =
      pkg.classes.length + pkg.functions.length + pkg.types.length + pkg.constants.length > 0

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

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  writeFileSync(outputFile, lines.join('\n'), 'utf-8')

  const totalExports = packages.reduce(
    (sum, pkg) => sum + pkg.classes.length + pkg.functions.length + pkg.types.length + pkg.constants.length,
    0,
  )

  console.log(`Wrote ${outputFile} — ${packages.length} packages, ${totalExports} exports`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateCapabilityMatrix()
}
