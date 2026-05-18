#!/usr/bin/env node
/**
 * Scans every package under packages/ and generates docs/CAPABILITY_MATRIX.md
 * with a summary table and detailed export listings.
 *
 * Usage: node scripts/generate-capability-matrix.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

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

function collectDirectExports(source) {
  const classes = []
  const functions = []
  const types = []
  const constants = []

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

  return { classes, functions, types, constants }
}

function dedupeExports(exportsShape) {
  return {
    classes: [...new Set(exportsShape.classes)],
    functions: [...new Set(exportsShape.functions)],
    types: [...new Set(exportsShape.types)],
    constants: [...new Set(exportsShape.constants)],
  }
}

function mergeExports(target, source) {
  target.classes.push(...source.classes)
  target.functions.push(...source.functions)
  target.types.push(...source.types)
  target.constants.push(...source.constants)
}

function resolveLocalModulePath(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null

  const base = resolve(dirname(fromFile), specifier)
  const extensionlessBase = base.replace(/\.(mjs|cjs|js)$/, '')
  const candidates = [
    base,
    extensionlessBase,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${extensionlessBase}.ts`,
    `${extensionlessBase}.tsx`,
    `${extensionlessBase}.mts`,
    `${extensionlessBase}.cts`,
    `${extensionlessBase}.js`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.mts'),
    join(base, 'index.cts'),
    join(base, 'index.js'),
    join(extensionlessBase, 'index.ts'),
    join(extensionlessBase, 'index.tsx'),
    join(extensionlessBase, 'index.mts'),
    join(extensionlessBase, 'index.cts'),
    join(extensionlessBase, 'index.js'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

function extractExportsFromFile(filePath, visited = new Set()) {
  if (visited.has(filePath)) {
    return { classes: [], functions: [], types: [], constants: [] }
  }
  visited.add(filePath)

  let source
  try {
    source = readFileSync(filePath, 'utf-8')
  } catch {
    return { classes: [], functions: [], types: [], constants: [] }
  }

  const collected = collectDirectExports(source)

  for (const m of source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    const modulePath = resolveLocalModulePath(filePath, m[1])
    if (!modulePath) continue
    mergeExports(collected, extractExportsFromFile(modulePath, visited))
  }

  return dedupeExports(collected)
}

function extractExports(indexPath) {
  const primary = extractExportsFromFile(indexPath)
  const hasPrimaryExports =
    primary.classes.length + primary.functions.length + primary.types.length + primary.constants.length > 0
  if (hasPrimaryExports) return primary

  // Fallback: some packages are pure re-export barrels and regex-only recursive
  // extraction can still miss symbols in complex chains. Scan src/*.ts files.
  const srcDir = dirname(indexPath)
  const fallback = { classes: [], functions: [], types: [], constants: [] }
  const stack = [srcDir]
  const visitedDirs = new Set()

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir || visitedDirs.has(dir)) continue
    visitedDirs.add(dir)

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sortedEntries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue
      if (/\.test\./.test(entry.name)) continue

      let source
      try {
        source = readFileSync(fullPath, 'utf-8')
      } catch {
        continue
      }
      mergeExports(fallback, collectDirectExports(source))
    }
  }

  return dedupeExports(fallback)
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
    let keyExports = [...pkg.classes.slice(0, 5), ...pkg.functions.slice(0, 3)]
    if (keyExports.length === 0) {
      keyExports = [...pkg.types.slice(0, 8), ...pkg.constants.slice(0, 2)]
    }
    const keyStr =
      keyExports.length > 0
        ? keyExports.join(', ') +
          (pkg.classes.length + pkg.functions.length + pkg.types.length + pkg.constants.length >
          keyExports.length
            ? ', ...'
            : '')
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
