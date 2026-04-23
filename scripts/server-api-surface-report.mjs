import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = path.resolve(import.meta.dirname, '..')
const workspaceRoot = path.resolve(repoRoot, '..')
const serverIndexPath = path.join(repoRoot, 'packages', 'server', 'src', 'index.ts')
const configPath = path.join(repoRoot, 'config', 'server-api-tiers.json')
const outputPath = path.join(repoRoot, 'docs', 'SERVER_API_SURFACE_INDEX.md')

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function parseExportNames(spec) {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+\w+$/, '').replace(/^type\s+/, '').trim())
}

function parseServerIndex(indexText) {
  const entries = []
  const exportBlockRe = /export(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g

  let match
  while ((match = exportBlockRe.exec(indexText)) !== null) {
    entries.push({
      source: match[2],
      exportNames: parseExportNames(match[1]),
    })
  }

  for (const localMatch of indexText.matchAll(/export\s+const\s+(\w+)\s*=/g)) {
    entries.push({
      source: `<local>:${localMatch[1]}`,
      exportNames: [localMatch[1]],
    })
  }

  return entries
}

function summarizeBySource(entries) {
  const bySource = new Map()
  for (const entry of entries) {
    const current = bySource.get(entry.source) ?? { source: entry.source, exportNames: [] }
    current.exportNames.push(...entry.exportNames)
    bySource.set(entry.source, current)
  }

  return [...bySource.values()].map((entry) => ({
    source: entry.source,
    exportNames: [...new Set(entry.exportNames)],
  }))
}

function matchRule(source, rules) {
  const matches = rules.filter((rule) => {
    if (rule.match === 'exact') return source === rule.pattern
    if (rule.match === 'prefix') return source.startsWith(rule.pattern)
    return false
  })

  if (matches.length !== 1) {
    const formatted = matches.map((rule) => `${rule.match}:${rule.pattern}`).join(', ') || '(none)'
    throw new Error(`Expected exactly one tier rule for ${source}, got ${formatted}`)
  }

  return matches[0]
}

function collectFiles(rootDir, predicate, results = []) {
  if (!existsSync(rootDir)) return results

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'coverage' ||
        entry.name === '.git' ||
        entry.name === 'docs' ||
        entry.name === '__snapshots__'
      ) {
        continue
      }
      collectFiles(full, predicate, results)
      continue
    }

    if (entry.isFile() && predicate(full)) {
      results.push(full)
    }
  }

  return results
}

function isCodeFile(filePath) {
  return /\.(ts|tsx|js|jsx|mjs|mts|cjs|cts|vue)$/.test(filePath)
}

function extractRootImports(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const imports = []

  function recordBindings(namedBindings) {
    if (!namedBindings || !ts.isNamedImports(namedBindings)) return
    for (const element of namedBindings.elements) {
      imports.push((element.propertyName ?? element.name).text)
    }
  }

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@dzupagent/server'
    ) {
      recordBindings(node.importClause?.namedBindings)
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@dzupagent/server' &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        imports.push((element.propertyName ?? element.name).text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

function collectRootImportUsage() {
  const roots = [
    path.join(workspaceRoot, 'apps'),
    path.join(workspaceRoot, 'help'),
    path.join(workspaceRoot, 'shared-kit'),
    path.join(repoRoot, 'packages'),
  ]

  const files = roots.flatMap((root) => collectFiles(root, isCodeFile))
  const usage = new Map()

  for (const file of files) {
    if (file.includes(`${path.sep}packages${path.sep}server${path.sep}`)) continue

    const text = readFileSync(file, 'utf8')
    const imports = extractRootImports(file, text)
    if (imports.length === 0) continue

    const relFile = path.relative(workspaceRoot, file)
    for (const importedName of imports) {
      const current = usage.get(importedName) ?? { name: importedName, files: [] }
      current.files.push(relFile)
      usage.set(importedName, current)
    }
  }

  return [...usage.values()]
    .map((item) => ({
      name: item.name,
      files: [...new Set(item.files)].sort(),
      fileCount: [...new Set(item.files)].length,
    }))
    .sort((left, right) => right.fileCount - left.fileCount || left.name.localeCompare(right.name))
}

function buildMarkdown({ inventory, rootUsage, generatedOn }) {
  const tierCounts = inventory.reduce((acc, row) => {
    acc[row.tier] = (acc[row.tier] ?? 0) + 1
    return acc
  }, {})
  const exposureCounts = inventory.reduce((acc, row) => {
    acc[row.recommendedRootExposure] = (acc[row.recommendedRootExposure] ?? 0) + 1
    return acc
  }, {})

  const lines = []
  lines.push('# Server API Surface Index')
  lines.push('')
  lines.push(`Date: ${generatedOn}`)
  lines.push('')
  lines.push('Generated from `packages/server/src/index.ts` and `config/server-api-tiers.json`.')
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Unique export sources in root index: \`${inventory.length}\``)
  lines.push(`- Tier counts: stable=\`${tierCounts.stable ?? 0}\`, secondary=\`${tierCounts.secondary ?? 0}\`, experimental=\`${tierCounts.experimental ?? 0}\`, internal=\`${tierCounts.internal ?? 0}\``)
  lines.push(`- Recommended root exposure: keep-root=\`${exposureCounts['keep-root'] ?? 0}\`, candidate-subpath=\`${exposureCounts['candidate-subpath'] ?? 0}\`, remove-root=\`${exposureCounts['remove-root'] ?? 0}\``)
  lines.push('')
  lines.push('## Current Direct Root Imports')
  lines.push('')

  const rootUsageTierCounts = rootUsage.reduce((acc, item) => {
    acc[item.tier] = (acc[item.tier] ?? 0) + 1
    return acc
  }, {})

  if (rootUsage.length === 0) {
    lines.push('No direct `@dzupagent/server` root imports found in scanned workspace code.')
  } else {
    lines.push(`- Imported symbols by tier: stable=\`${rootUsageTierCounts.stable ?? 0}\`, secondary=\`${rootUsageTierCounts.secondary ?? 0}\`, experimental=\`${rootUsageTierCounts.experimental ?? 0}\`, internal=\`${rootUsageTierCounts.internal ?? 0}\`, unknown=\`${rootUsageTierCounts.unknown ?? 0}\``)
    lines.push('')
    lines.push('| Import | Tier | Source Module | Root Exposure | Files | Sample Consumers |')
    lines.push('| --- | --- | --- | --- | ---: | --- |')
    for (const item of rootUsage) {
      const sample = item.files.slice(0, 3).map((file) => `\`${file}\``).join(', ')
      lines.push(`| \`${item.name}\` | \`${item.tier}\` | \`${item.source}\` | \`${item.recommendedRootExposure}\` | ${item.fileCount} | ${sample} |`)
    }
  }

  lines.push('')
  lines.push('## Root Export Inventory')
  lines.push('')
  lines.push('| Source Module | Tier | Area | Root Exposure | Export Count | Sample Exports |')
  lines.push('| --- | --- | --- | --- | ---: | --- |')
  for (const row of inventory) {
    const sampleExports = row.exportNames.slice(0, 4).map((name) => `\`${name}\``).join(', ')
    lines.push(
      `| \`${row.source}\` | \`${row.tier}\` | \`${row.area}\` | \`${row.recommendedRootExposure}\` | ${row.exportNames.length} | ${sampleExports} |`,
    )
  }

  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- `stable` means keep in the root package unless a strong compatibility reason appears.')
  lines.push('- `secondary` means supported, but a candidate for subpath exports to keep the root surface smaller.')
  lines.push('- `experimental` means feature-rich or optional planes that should not silently define the default server contract.')
  lines.push('- `internal` means the symbol source is currently exposed from the root index but should be treated as a root-surface leak and moved or hidden over time.')
  lines.push('')
  lines.push('Regenerate with `yarn docs:server-api-surface`.')
  return `${lines.join('\n')}\n`
}

function main() {
  const config = readJson(configPath)
  const serverIndex = readFileSync(serverIndexPath, 'utf8')
  const entries = summarizeBySource(parseServerIndex(serverIndex))
  const inventory = entries.map((entry) => {
    const rule = matchRule(entry.source, config.rules)
    return {
      source: entry.source,
      exportNames: entry.exportNames,
      tier: rule.tier,
      area: rule.area,
      recommendedRootExposure: rule.recommendedRootExposure,
      reason: rule.reason,
    }
  })

  const exportLookup = new Map()
  for (const row of inventory) {
    for (const exportName of row.exportNames) {
      if (!exportLookup.has(exportName)) {
        exportLookup.set(exportName, [])
      }
      exportLookup.get(exportName).push(row)
    }
  }

  const rootUsage = collectRootImportUsage().map((item) => {
    const matches = exportLookup.get(item.name) ?? []
    if (matches.length === 1) {
      return {
        ...item,
        tier: matches[0].tier,
        source: matches[0].source,
        recommendedRootExposure: matches[0].recommendedRootExposure,
      }
    }

    return {
      ...item,
      tier: 'unknown',
      source: matches.length > 1 ? '(multiple)' : '(unresolved)',
      recommendedRootExposure: 'review',
    }
  })
  const generatedOn = new Date().toISOString().slice(0, 10)
  const content = buildMarkdown({ inventory, rootUsage, generatedOn })

  if (process.argv.includes('--check')) {
    const committed = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
    if (committed !== content) {
      console.error('SERVER_API_SURFACE_INDEX.md is stale. Run: yarn docs:server-api-surface')
      process.exit(1)
    }
    console.log('SERVER_API_SURFACE_INDEX.md is up to date.')
    return
  }

  writeFileSync(outputPath, content, 'utf8')
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`)
}

main()
