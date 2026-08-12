#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_CONFIG = 'config/memory-api-census.v1.json'
const DEFAULT_JSON = 'docs/generated/MEMORY_API_CENSUS.v1.json'
const DEFAULT_MARKDOWN = 'docs/generated/MEMORY_API_CENSUS.v1.md'
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function asObject(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function portablePath(path) {
  return path.split(sep).join('/')
}

function sortBy(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)))
}

function hasExportModifier(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function declarationName(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null
}

export function extractExportsFromSource(source, sourcePath = '<memory>') {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const exports = []

  function add(symbol, kind, sourceModule, sourceSymbol = symbol) {
    if (!symbol) return
    exports.push({ symbol, kind, sourceModule, sourceSymbol })
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const sourceModule = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : '<local>'

      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          add(
            element.name.text,
            statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
            sourceModule,
            element.propertyName?.text ?? element.name.text,
          )
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        add(statement.exportClause.name.text, 'namespace', sourceModule)
      } else if (!statement.exportClause) {
        add('*', statement.isTypeOnly ? 'type-wildcard' : 'wildcard', sourceModule)
      }
      continue
    }

    if (!hasExportModifier(statement)) continue

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      add(declarationName(statement), 'type', `<local>:${declarationName(statement)}`)
    } else if (ts.isClassDeclaration(statement)) {
      add(declarationName(statement), 'class', `<local>:${declarationName(statement)}`)
    } else if (ts.isFunctionDeclaration(statement)) {
      add(declarationName(statement), 'function', `<local>:${declarationName(statement)}`)
    } else if (ts.isEnumDeclaration(statement)) {
      add(declarationName(statement), 'enum', `<local>:${declarationName(statement)}`)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          add(declaration.name.text, 'value', `<local>:${declaration.name.text}`)
        }
      }
    }
  }

  const unique = new Map()
  for (const item of exports) {
    unique.set(`${item.symbol}\0${item.kind}\0${item.sourceModule}\0${item.sourceSymbol}`, item)
  }
  return sortBy(unique.values(), item => `${item.symbol}\0${item.kind}\0${item.sourceModule}`)
}

function matchesRule(sourceModule, rule) {
  if (rule.match === 'exact') return sourceModule === rule.pattern
  if (rule.match === 'prefix') return sourceModule.startsWith(rule.pattern)
  throw new Error(`Unsupported public API allowlist rule: ${JSON.stringify(rule)}`)
}

function packageDirectoryForEntry(entry) {
  const parts = portablePath(entry).split('/')
  assert(parts[0] === 'packages' && parts.length >= 3, `Cannot derive package directory from ${entry}`)
  return parts.slice(0, 2).join('/')
}

function exportKeyForSurface(surface) {
  if (surface.specifier === surface.owner) return '.'
  assert(
    surface.specifier.startsWith(`${surface.owner}/`),
    `${surface.id} public specifier must start with ${surface.owner}/`,
  )
  return `./${surface.specifier.slice(surface.owner.length + 1)}`
}

function classifyApi(surface, row, allowlistByPackage) {
  if (surface.visibility === 'internal') return 'internal'

  const packageRule = allowlistByPackage.get(surface.owner)
  if (!packageRule) return 'unclassified-package'
  const exportKey = exportKeyForSurface(surface)
  if (exportKey !== '.') {
    return Object.hasOwn(packageRule.subpaths ?? {}, exportKey)
      ? 'declared-subpath'
      : 'unclassified-subpath'
  }
  if ((packageRule.stableRoot ?? []).some(rule => matchesRule(row.sourceModule, rule))) return 'stable-root'
  if ((packageRule.transitionalRoot ?? []).some(rule => matchesRule(row.sourceModule, rule))) {
    return 'transitional-root'
  }
  return 'unclassified-root'
}

function validatePublicExportMap(root, surface) {
  if (surface.visibility === 'internal') return null
  const packageDir = packageDirectoryForEntry(surface.entry)
  const packagePath = join(root, packageDir, 'package.json')
  const packageJson = readJson(packagePath)
  const exportKey = exportKeyForSurface(surface)
  assert(packageJson.name === surface.owner, `${surface.id} owner does not match ${packagePath}`)
  assert(
    typeof packageJson.exports === 'object' && packageJson.exports !== null && Object.hasOwn(packageJson.exports, exportKey),
    `${surface.id} references missing package export ${surface.owner} ${exportKey}`,
  )
  return portablePath(relative(root, packagePath))
}

function buildCurrentRows(root, config, allowlistByPackage) {
  const rows = []
  const inputPaths = new Set()
  const surfacesById = new Map()

  for (const rawSurface of config.currentSurfaces) {
    const surface = asObject(rawSurface, 'current surface')
    assert(typeof surface.id === 'string' && surface.id.length > 0, 'current surface id is required')
    assert(!surfacesById.has(surface.id), `duplicate current surface id ${surface.id}`)
    surfacesById.set(surface.id, surface)
    const entryPath = join(root, surface.entry)
    assert(existsSync(entryPath), `${surface.id} entry is missing: ${surface.entry}`)
    inputPaths.add(surface.entry)
    const packagePath = validatePublicExportMap(root, surface)
    if (packagePath) inputPaths.add(packagePath)

    let extracted = extractExportsFromSource(readFileSync(entryPath, 'utf8'), surface.entry)
    if (surface.includeSymbols) {
      const include = new Set(surface.includeSymbols)
      const available = new Set(extracted.map(item => item.symbol))
      for (const symbol of include) {
        assert(available.has(symbol), `${surface.id} includeSymbols references missing export ${symbol}`)
      }
      extracted = extracted.filter(item => include.has(item.symbol))
    }

    for (const item of extracted) {
      rows.push({
        surfaceId: surface.id,
        owner: surface.owner,
        specifier: surface.specifier,
        visibility: surface.visibility,
        sourceFile: surface.entry,
        ...item,
        apiClass: classifyApi(surface, item, allowlistByPackage),
        disposition: surface.defaultDisposition,
        target: null,
        rationale: 'Retain current behavior and compatibility unless an explicit override applies.',
      })
    }
  }

  const rowRefs = new Map()
  for (const row of rows) {
    const ref = `${row.surfaceId}:${row.symbol}`
    const matches = rowRefs.get(ref) ?? []
    matches.push(row)
    rowRefs.set(ref, matches)
  }

  for (const override of config.currentOverrides) {
    const ref = `${override.surfaceId}:${override.symbol}`
    const matches = rowRefs.get(ref)
    assert(matches?.length > 0, `current override references missing export ${ref}`)
    for (const row of matches) {
      row.disposition = override.disposition
      row.target = override.target
      row.rationale = override.rationale
    }
  }

  return {
    rows: sortBy(rows, row => `${row.surfaceId}\0${row.symbol}\0${row.kind}`),
    rowRefs,
    inputPaths,
    surfacesById,
  }
}

function validateConfig(root, config, current) {
  assert(config.schema === 'datazup.memory.api-census-config/v1', `Unsupported census config schema ${config.schema}`)
  const dispositions = new Set(config.surfaceDispositionValues)
  assert(dispositions.size === 4, 'surfaceDispositionValues must contain four unique values')
  for (const required of ['reuse', 'extend', 'deprecate', 'new']) {
    assert(dispositions.has(required), `surfaceDispositionValues is missing ${required}`)
  }

  for (const surface of config.currentSurfaces) {
    assert(dispositions.has(surface.defaultDisposition), `${surface.id} has invalid default disposition`)
  }
  for (const override of config.currentOverrides) {
    assert(dispositions.has(override.disposition), `${override.surfaceId}:${override.symbol} has invalid disposition`)
    assert(typeof override.rationale === 'string' && override.rationale.length > 20, `${override.surfaceId}:${override.symbol} needs a rationale`)
  }

  const plannedKeys = new Set()
  for (const planned of config.plannedSurfaces) {
    const key = `${planned.owner}:${planned.specifier}:${planned.symbol}`
    assert(!plannedKeys.has(key), `duplicate planned surface ${key}`)
    plannedKeys.add(key)
    assert(dispositions.has(planned.disposition), `${key} has invalid disposition`)
    assert(/^MEM-P\d{3}$/.test(planned.packet), `${key} has invalid packet ${planned.packet}`)
    assert(Array.isArray(planned.overlaps), `${key} overlaps must be an array`)
    if (planned.disposition === 'extend' || planned.disposition === 'deprecate' || planned.disposition === 'reuse') {
      assert(planned.overlaps.length > 0, `${key} disposition ${planned.disposition} requires an existing overlap`)
    }
    for (const overlap of planned.overlaps) {
      assert(current.rowRefs.has(overlap), `${key} references missing overlap ${overlap}`)
    }
  }

  const capabilityIds = new Set()
  for (const capability of config.capabilities) {
    assert(!capabilityIds.has(capability.id), `duplicate capability ${capability.id}`)
    capabilityIds.add(capability.id)
    assert(dispositions.has(capability.disposition), `${capability.id} has invalid disposition`)
    assert(capability.sourceFiles.length > 0, `${capability.id} needs at least one source file`)
    assert(capability.characterizationTests.length > 0, `${capability.id} needs characterization tests`)
    for (const path of [...capability.sourceFiles, ...capability.characterizationTests]) {
      assert(existsSync(join(root, path)), `${capability.id} references missing file ${path}`)
      current.inputPaths.add(path)
    }
  }
}

function buildCollisions(currentRows, plannedSurfaces) {
  const bySymbol = new Map()
  for (const row of currentRows) {
    const items = bySymbol.get(row.symbol) ?? []
    items.push(row)
    bySymbol.set(row.symbol, items)
  }

  const collisions = []
  for (const [symbol, occurrences] of bySymbol) {
    const surfaceIds = new Set(occurrences.map(item => item.surfaceId))
    if (surfaceIds.size < 2) continue
    const occurrenceRefs = new Set(occurrences.map(item => `${item.surfaceId}:${item.symbol}`))
    const plannedOverlaps = plannedSurfaces
      .filter(item => item.overlaps.some(ref => occurrenceRefs.has(ref)) || item.symbol === symbol)
      .map(item => `${item.packet}:${item.specifier}:${item.symbol}`)
      .sort()
    collisions.push({
      symbol,
      resolution: plannedOverlaps.length > 0
        ? 'explicit-planned-overlap'
        : 'retain-surface-qualified-current-exports',
      current: sortBy(
        occurrences.map(item => ({
          ref: `${item.surfaceId}:${item.symbol}`,
          specifier: item.specifier,
          kind: item.kind,
          disposition: item.disposition,
        })),
        item => `${item.ref}\0${item.kind}`,
      ),
      plannedOverlaps,
    })
  }
  return sortBy(collisions, item => item.symbol)
}

function countBy(values, selector) {
  const counts = {}
  for (const value of values) {
    const key = selector(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function inputDigestRows(root, paths) {
  return [...paths]
    .sort()
    .map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }))
}

export function buildMemoryApiCensus(root = DEFAULT_ROOT, configPath = DEFAULT_CONFIG) {
  const absoluteRoot = resolve(root)
  const configAbsolute = resolve(absoluteRoot, configPath)
  const config = readJson(configAbsolute)
  const allowlistPath = join(absoluteRoot, 'config/public-api-allowlists.json')
  const allowlist = readJson(allowlistPath)
  const allowlistByPackage = new Map(allowlist.packages.map(item => [item.packageName, item]))
  const current = buildCurrentRows(absoluteRoot, config, allowlistByPackage)
  current.inputPaths.add(portablePath(relative(absoluteRoot, configAbsolute)))
  current.inputPaths.add('scripts/generate-memory-api-census.mjs')
  validateConfig(absoluteRoot, config, current)

  const currentRows = current.rows.map(row => ({ ...row }))
  const plannedSurfaces = sortBy(config.plannedSurfaces, item => `${item.packet}\0${item.owner}\0${item.specifier}\0${item.symbol}`)
  const inputDigests = inputDigestRows(absoluteRoot, current.inputPaths)
  const relevantAllowlistPackages = [...new Set(
    config.currentSurfaces
      .filter(surface => surface.visibility !== 'internal')
      .map(surface => surface.owner),
  )].sort()
  const allowlistProjection = relevantAllowlistPackages.map(packageName => {
    const packageRule = allowlistByPackage.get(packageName)
    assert(packageRule, `public API allowlist is missing relevant package ${packageName}`)
    return packageRule
  })
  inputDigests.push({
    path: 'config/public-api-allowlists.json',
    selection: { packageNames: relevantAllowlistPackages },
    sha256: sha256(jsonText(allowlistProjection)),
  })
  inputDigests.sort((left, right) => left.path.localeCompare(right.path))
  const inputSetDigest = sha256(inputDigests.map(item => `${item.path}\0${item.sha256}`).join('\n'))
  const currentDecisions = currentRows.filter(row => row.disposition !== 'reuse')
  const apiClassCounts = countBy(currentRows, row => row.apiClass)

  return {
    schema: 'datazup.memory.api-census/v1',
    packet: 'MEM-P000',
    sourceIdentity: {
      kind: 'content-digest-set',
      digest: inputSetDigest,
      inputs: inputDigests,
    },
    summary: {
      currentExportCount: currentRows.length,
      currentSurfaceCount: config.currentSurfaces.length,
      currentDecisionCount: currentDecisions.length,
      plannedSurfaceCount: plannedSurfaces.length,
      capabilityCount: config.capabilities.length,
      currentByDisposition: countBy(currentRows, row => row.disposition),
      plannedByDisposition: countBy(plannedSurfaces, row => row.disposition),
      plannedByPacket: countBy(plannedSurfaces, row => row.packet),
      apiClassCounts,
    },
    ownership: {
      semanticContextPlane: [
        '@dzupagent/agent-types transport primitives',
        '@dzupagent/memory lifecycle, storage ports, retrieval, and projections',
        '@dzupagent/context prompt construction and compaction',
        '@dzupagent/memory-ipc Arrow and transport primitives',
        '@dzupagent/agent opt-in context-loader integration',
      ],
      operationalEvidencePlane: [
        'dzupagent-orchestration reference-only intents and deterministic projections',
        'host and application ledgers, effects, authorization, consent, retention, and evidence custody',
      ],
      forbiddenOwnershipTransfers: [
        'semantic payloads into orchestration state',
        'product authorization or consent into provider-neutral packages',
        'Flow Lab logs or receipts into semantic memory without a bounded reference projection',
      ],
    },
    currentSurfaces: currentRows,
    currentDecisions,
    collisions: buildCollisions(currentRows, plannedSurfaces),
    plannedSurfaces,
    capabilities: sortBy(config.capabilities, item => item.id),
  }
}

function collectSourceFiles(root, excludedDirectoryNames) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!excludedDirectoryNames.has(entry.name)) stack.push(fullPath)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(fullPath)
      }
    }
  }
  return files.sort()
}

function moduleImportRows(source, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const rows = []

  function add(specifier, importedNames, importKind) {
    if (typeof specifier !== 'string') return
    rows.push({
      specifier,
      importedNames: [...new Set(importedNames)].sort(),
      importKind,
    })
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = []
      const clause = node.importClause
      if (!clause) {
        add(node.moduleSpecifier.text, [], 'side-effect')
      } else {
        if (clause.name) names.push('default')
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('*')
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) names.push(element.propertyName?.text ?? element.name.text)
        }
        const namedKinds = clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? new Set(clause.namedBindings.elements.map(element => element.isTypeOnly ? 'type' : 'value'))
          : new Set()
        const importKind = clause.isTypeOnly
          ? 'type'
          : namedKinds.size > 1
            ? 'mixed'
            : namedKinds.has('type') && !clause.name
              ? 'type'
              : 'value'
        add(node.moduleSpecifier.text, names, importKind)
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(element => element.propertyName?.text ?? element.name.text)
        : ['*']
      add(node.moduleSpecifier.text, names, node.isTypeOnly ? 'type-reexport' : 'reexport')
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        add(node.arguments[0].text, [], isDynamicImport ? 'dynamic' : 'require')
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return rows
}

function nearestPackageName(filePath, workspaceRoot, cache) {
  let current = dirname(filePath)
  while (current.startsWith(workspaceRoot)) {
    if (cache.has(current)) return cache.get(current)
    const packagePath = join(current, 'package.json')
    if (existsSync(packagePath)) {
      const name = readJson(packagePath).name ?? portablePath(relative(workspaceRoot, current))
      cache.set(current, name)
      return name
    }
    if (current === workspaceRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function consumerUseClass(path) {
  if (/(^|\/)(__tests__|test|tests)(\/|$)|\.(spec|test)\.[^.]+$/.test(path)) return 'test'
  if (/(^|\/)scripts?\//.test(path)) return 'tooling'
  return 'runtime'
}

function matchedPackagePrefix(specifier, prefixes) {
  return prefixes.find(prefix => specifier === prefix || specifier.startsWith(`${prefix}/`)) ?? null
}

export function scanWorkspaceMemoryConsumers(workspaceRoot, consumerConfig) {
  const absoluteWorkspace = resolve(workspaceRoot)
  const excluded = new Set(consumerConfig.excludedDirectoryNames)
  const prefixes = [...consumerConfig.packagePrefixes].sort((left, right) => right.length - left.length)
  for (const [packageName, symbols] of Object.entries(consumerConfig.packageSymbolAllowlist ?? {})) {
    assert(prefixes.includes(packageName), `consumer symbol allowlist references unscanned package ${packageName}`)
    assert(Array.isArray(symbols) && symbols.length > 0, `consumer symbol allowlist for ${packageName} must not be empty`)
    assert(symbols.every(symbol => typeof symbol === 'string' && symbol.length > 0), `consumer symbol allowlist for ${packageName} contains an invalid symbol`)
  }
  const packageNameCache = new Map()
  const rows = []

  for (const configuredRoot of consumerConfig.roots) {
    const scanRoot = join(absoluteWorkspace, configuredRoot)
    assert(existsSync(scanRoot) && statSync(scanRoot).isDirectory(), `consumer scan root is missing: ${configuredRoot}`)
    for (const filePath of collectSourceFiles(scanRoot, excluded)) {
      const source = readFileSync(filePath, 'utf8')
      const relativePath = portablePath(relative(absoluteWorkspace, filePath))
      const sourceDigest = sha256(source)
      for (const item of moduleImportRows(source, relativePath)) {
        const packagePrefix = matchedPackagePrefix(item.specifier, prefixes)
        if (!packagePrefix) continue
        const symbolAllowlist = consumerConfig.packageSymbolAllowlist?.[packagePrefix]
        if (
          symbolAllowlist
          && item.importedNames.length > 0
          && !item.importedNames.includes('*')
          && !item.importedNames.some(symbol => symbolAllowlist.includes(symbol))
        ) {
          continue
        }
        rows.push({
          consumerRoot: relativePath.split('/').slice(0, 2).join('/'),
          consumerPackage: nearestPackageName(filePath, absoluteWorkspace, packageNameCache),
          file: relativePath,
          useClass: consumerUseClass(relativePath),
          package: packagePrefix,
          specifier: item.specifier,
          importKind: item.importKind,
          importedNames: item.importedNames,
          sourceSha256: sourceDigest,
        })
      }
    }
  }

  const sortedRows = sortBy(rows, row => `${row.file}\0${row.specifier}\0${row.importKind}\0${row.importedNames.join(',')}`)
  return {
    schema: 'datazup.memory.consumer-import-census/v1',
    packet: 'MEM-P000',
    sourceIdentity: {
      kind: 'workspace-relative-import-content-digests',
      digest: sha256(sortedRows.map(row => `${row.file}\0${row.sourceSha256}\0${row.specifier}\0${row.importKind}\0${row.importedNames.join(',')}`).join('\n')),
    },
    summary: {
      importDeclarationCount: sortedRows.length,
      consumerFileCount: new Set(sortedRows.map(row => row.file)).size,
      consumerPackageCount: new Set(sortedRows.map(row => row.consumerPackage)).size,
      byPackage: countBy(sortedRows, row => row.package),
      byConsumerRoot: countBy(sortedRows, row => row.consumerRoot),
      byUseClass: countBy(sortedRows, row => row.useClass),
    },
    imports: sortedRows,
  }
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function renderMarkdown(census) {
  const lines = [
    '# Memory API census and disposition baseline',
    '',
    '<!-- GENERATED by scripts/generate-memory-api-census.mjs; do not edit directly. -->',
    '',
    `- Packet: \`${census.packet}\``,
    `- Source input digest: \`${census.sourceIdentity.digest}\``,
    `- Current exports inventoried: \`${census.summary.currentExportCount}\` across \`${census.summary.currentSurfaceCount}\` surfaces`,
    `- Planned surfaces decided: \`${census.summary.plannedSurfaceCount}\``,
    `- Characterized capability groups: \`${census.summary.capabilityCount}\``,
    '',
    '## Ownership boundary',
    '',
    'Semantic/context contracts, retrieval, and provider-neutral adapters remain in DzupAgent packages. Operational evidence, effects, authorization, consent, and product retention decisions remain in orchestration hosts and applications. Only bounded references cross that plane boundary.',
    '',
    '## Current surface summary',
    '',
    '| Disposition | Count |',
    '| --- | ---: |',
  ]
  for (const [disposition, count] of Object.entries(census.summary.currentByDisposition)) {
    lines.push(`| \`${disposition}\` | ${count} |`)
  }

  lines.push('', '## Explicit current decisions', '', '| Surface | Symbol | Disposition | Target | Rationale |', '| --- | --- | --- | --- | --- |')
  for (const item of census.currentDecisions) {
    lines.push(`| \`${markdownCell(item.specifier)}\` | \`${markdownCell(item.symbol)}\` | \`${item.disposition}\` | ${markdownCell(item.target)} | ${markdownCell(item.rationale)} |`)
  }

  lines.push('', '## Planned surfaces', '', '| Packet | Owner | Subpath | Symbol | Kind | Disposition | Overlap |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const item of census.plannedSurfaces) {
    lines.push(`| \`${item.packet}\` | ${markdownCell(item.owner)} | \`${markdownCell(item.specifier)}\` | \`${markdownCell(item.symbol)}\` | ${item.kind} | \`${item.disposition}\` | ${item.overlaps.map(value => `\`${markdownCell(value)}\``).join(', ')} |`)
  }

  lines.push('', '## Characterization coverage', '', '| Capability | Owner | Disposition | Source files | Characterization tests |', '| --- | --- | --- | ---: | ---: |')
  for (const item of census.capabilities) {
    lines.push(`| \`${item.id}\` | ${markdownCell(item.owner)} | \`${item.disposition}\` | ${item.sourceFiles.length} | ${item.characterizationTests.length} |`)
  }

  lines.push(
    '',
    '## Compatibility rules',
    '',
    '- Existing root exports stay source-compatible during the 0.x migration window.',
    '- New lifecycle contracts land on narrow subpaths; the memory root barrel is not widened automatically.',
    '- `MemoryRecord`, `MemoryScope`, and `MemoryQuery` in `@dzupagent/agent-types` remain Layer-0 transport shapes and adapt to, rather than become, the semantic v1 record.',
    '- `StagedWriter` remains available for compatibility but is not accepted as the canonical authority or promotion reducer.',
    '- Application and shared-kit imports are recorded separately by the workspace consumer census and require no source mutation for MEM-P000.',
    '',
  )
  return `${lines.join('\n')}\n`
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function writeOrCheck(path, content, check) {
  if (check) {
    assert(existsSync(path), `generated file is missing: ${path}`)
    assert(readFileSync(path, 'utf8') === content, `generated file is stale: ${path}`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: DEFAULT_ROOT,
    config: DEFAULT_CONFIG,
    json: DEFAULT_JSON,
    markdown: DEFAULT_MARKDOWN,
    workspaceRoot: null,
    consumerOutput: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') {
      options.check = true
      continue
    }
    const key = {
      '--root': 'root',
      '--config': 'config',
      '--json': 'json',
      '--markdown': 'markdown',
      '--workspace-root': 'workspaceRoot',
      '--consumer-output': 'consumerOutput',
    }[arg]
    assert(key, `Unknown argument ${arg}`)
    index += 1
    assert(index < argv.length, `${arg} requires a value`)
    options[key] = argv[index]
  }
  assert(
    (options.workspaceRoot === null) === (options.consumerOutput === null),
    '--workspace-root and --consumer-output must be supplied together',
  )
  return options
}

export function runMemoryApiCensus(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const root = resolve(options.root)
  const census = buildMemoryApiCensus(root, options.config)
  const jsonPath = resolve(root, options.json)
  const markdownPath = resolve(root, options.markdown)
  writeOrCheck(jsonPath, jsonText(census), options.check)
  writeOrCheck(markdownPath, renderMarkdown(census), options.check)

  let consumerCensus = null
  if (options.workspaceRoot && options.consumerOutput) {
    const config = readJson(resolve(root, options.config))
    consumerCensus = scanWorkspaceMemoryConsumers(options.workspaceRoot, config.consumerScan)
    writeOrCheck(resolve(options.consumerOutput), jsonText(consumerCensus), options.check)
  }

  return { census, consumerCensus, check: options.check, jsonPath, markdownPath }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    const result = runMemoryApiCensus()
    const verb = result.check ? 'verified' : 'generated'
    console.log(`Memory API census ${verb}: ${portablePath(relative(DEFAULT_ROOT, result.jsonPath))}`)
    console.log(`Memory API census ${verb}: ${portablePath(relative(DEFAULT_ROOT, result.markdownPath))}`)
    if (result.consumerCensus) {
      console.log(`Workspace consumer imports: ${result.consumerCensus.summary.importDeclarationCount}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
