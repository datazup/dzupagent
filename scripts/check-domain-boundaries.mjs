/**
 * check-domain-boundaries.mjs
 *
 * Enforces architectural boundary rules for the @dzupagent monorepo.
 *
 * Checks performed:
 *   1. Universal @dzupagent/* packages MUST NOT import domain-specific
 *      packages that were extracted out of dzupagent/packages/ (legacy rule).
 *   2. Every workspace package under packages/ MUST be classified in BOTH
 *      config/package-tiers.json and the layer graph in
 *      config/architecture-boundaries.json. A new, unclassified package
 *      fails this check.
 *   3. Layer 0 governance must be explicit about whether it is type-only or
 *      leaf-runtime capable, and its labels must match that runtime profile.
 *   4. The layer graph must be acyclic and consistent: a package may only
 *      depend on packages in strictly lower-numbered layers.
 *   5. Tier-1 and tier-2 (supported) packages MUST NOT take a runtime
 *      dependency on a tier-3 tooling/parked package.
 *   6. The runtime dependency graph (packages/<pkg>/package.json
 *      dependencies + peerDependencies) must be acyclic.
 *   7. Production src/** imports from sibling @dzupagent/* workspace packages
 *      must be declared in dependencies, peerDependencies, or
 *      optionalDependencies. Type-only imports are not exempt because emitted
 *      declaration files still expose the package contract.
 *   8. Production src/** imports from sibling @dzupagent/* workspace packages
 *      must not violate config/architecture-boundaries.json
 *      packageBoundaryRules forbidden package pairs.
 *   9. Production files under packages/server/src/routes/** must be declared
 *      in the serverRouteBoundaries policy with a maintenance/compatibility,
 *      generic framework primitive, or route-plugin host-seam rationale.
 *  10. Hono method/path endpoints inside classified server route files must
 *      match the server route endpoint manifest, including the inherited
 *      ownership category and mounted path review signal.
 *  11. ForgeServerConfig route-family fields must match the server route
 *      governance review signal before built-in route families grow.
 *
 * Usage:
 *   node scripts/check-domain-boundaries.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')
const tiersConfigPath = join(repoRoot, 'config', 'package-tiers.json')
const architectureConfigPath = join(repoRoot, 'config', 'architecture-boundaries.json')
const publicApiAllowlistsPath = join(repoRoot, 'config', 'public-api-allowlists.json')

/**
 * Domain packages that were moved out of dzupagent/packages/.
 * Any import of these inside packages/ is a boundary violation.
 */
const FORBIDDEN_IMPORTS = [
  '@dzupagent/domain-nl2sql',
  '@dzupagent/workflow-domain',
  '@dzupagent/org-domain',
  '@dzupagent/persona-registry',
  '@dzupagent/scheduler',
  '@dzupagent/execution-ledger',
]

const SOURCE_IMPORT_MANIFEST_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]

const SERVER_ROUTE_BOUNDARY_CATEGORIES = new Set([
  'compatibility-maintenance',
  'framework-primitive',
  'route-plugin-host-seam',
  'internal-support',
])

const HONO_ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'])

/**
 * Run ripgrep and return matching lines (empty array = no matches).
 */
function rg(args) {
  try {
    const output = execFileSync('rg', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output.trim().split('\n').filter(Boolean)
  } catch (error) {
    // rg exits with code 1 when no matches are found — that is success here
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return []
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Section 1 — Domain-package import check (legacy rule, preserved verbatim)
// ---------------------------------------------------------------------------

const domainViolations = []

for (const pkg of FORBIDDEN_IMPORTS) {
  // Match any import/require/dynamic-import of the forbidden package inside packages/
  // Exclude dist/, node_modules/, and test files (*.test.ts, __tests__/)
  const pattern = `['"]${pkg}['"/]`
  const matches = rg([
    '--glob', '!**/dist/**',
    '--glob', '!**/node_modules/**',
    '--glob', '!**/*.test.ts',
    '--glob', '!**/__tests__/**',
    '-l',                           // print only file paths
    '-e', pattern,
    packagesDir,
  ])

  for (const file of matches) {
    domainViolations.push({ pkg, file })
  }
}

// ---------------------------------------------------------------------------
// Section 2 — Discover workspace packages and read package.json metadata
// ---------------------------------------------------------------------------

function listWorkspacePackages() {
  const dirs = readdirSync(packagesDir)
    .filter((entry) => {
      try {
        return statSync(join(packagesDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
  const out = []
  for (const dir of dirs) {
    const pkgJsonPath = join(packagesDir, dir, 'package.json')
    let pkgJson
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    } catch {
      continue
    }
    out.push({
      dir,
      name: pkgJson.name,
      root: join(packagesDir, dir),
      runtimeDeps: {
        ...(pkgJson.dependencies || {}),
        ...(pkgJson.peerDependencies || {}),
      },
      sourceDeclaredDeps: Object.fromEntries(
        SOURCE_IMPORT_MANIFEST_FIELDS.flatMap((field) =>
          Object.keys(pkgJson[field] || {}).map((depName) => [depName, field]),
        ),
      ),
    })
  }
  return out
}

const workspacePackages = listWorkspacePackages()

// ---------------------------------------------------------------------------
// Section 3 — Load and validate the policy configs
// ---------------------------------------------------------------------------

let tiersConfig
let architectureConfig
let publicApiAllowlistsConfig = {}
try {
  tiersConfig = JSON.parse(readFileSync(tiersConfigPath, 'utf8'))
} catch (err) {
  console.error(`Failed to read ${tiersConfigPath}: ${err.message}`)
  process.exit(2)
}
try {
  architectureConfig = JSON.parse(readFileSync(architectureConfigPath, 'utf8'))
} catch (err) {
  console.error(`Failed to read ${architectureConfigPath}: ${err.message}`)
  process.exit(2)
}
if (existsSync(publicApiAllowlistsPath)) {
  try {
    publicApiAllowlistsConfig = JSON.parse(readFileSync(publicApiAllowlistsPath, 'utf8'))
  } catch (err) {
    console.error(`Failed to read ${publicApiAllowlistsPath}: ${err.message}`)
    process.exit(2)
  }
}

const layerGraph = architectureConfig.layerGraph
if (!layerGraph || !Array.isArray(layerGraph.layers)) {
  console.error('config/architecture-boundaries.json is missing a layerGraph.layers array.')
  process.exit(2)
}

const packageBoundaryRules = architectureConfig.packageBoundaryRules ?? []
if (!Array.isArray(packageBoundaryRules)) {
  console.error('config/architecture-boundaries.json packageBoundaryRules must be an array when present.')
  process.exit(2)
}

function textImpliesTypeOnlyRuntimeProfile(text) {
  return /\b(type-only|zero-runtime(?:-dep)?|runtime-free|contract-only)\b/i.test(text)
}

function layerZeroHasExternalRuntimeDeps(layer) {
  const layerPackageNames = new Set((layer?.packages ?? []).map((shortName) => `@dzupagent/${shortName}`))
  return workspacePackages.some((pkg) => {
    if (!layerPackageNames.has(pkg.name)) return false
    return Object.keys(pkg.runtimeDeps).some((depName) => {
      return !depName.startsWith('@dzupagent/') && depName !== 'create-dzupagent'
    })
  })
}

function collectLayerZeroGovernanceViolations() {
  const violations = []
  const layerZero = layerGraph.layers.find((layer) => layer.id === 0)
  const graphProfile = layerGraph.rules?.layerZeroRuntimeProfile
  const layerProfile = layerZero?.runtimeProfile
  const validProfiles = new Set(['type-only-contracts', 'leaf-runtime-primitives'])

  if (!layerZero) {
    return [{ type: 'missing-layer-zero' }]
  }

  if (!validProfiles.has(graphProfile)) {
    violations.push({
      type: 'invalid-runtime-profile',
      value: graphProfile,
    })
  }

  if (layerProfile !== graphProfile) {
    violations.push({
      type: 'runtime-profile-mismatch',
      layerProfile,
      graphProfile,
    })
  }

  const labelText = `${layerZero.name ?? ''} ${layerZero.description ?? ''} ${layerGraph.description ?? ''}`
  if (graphProfile === 'leaf-runtime-primitives' && textImpliesTypeOnlyRuntimeProfile(labelText)) {
    violations.push({
      type: 'leaf-runtime-type-only-label',
      layerName: layerZero.name,
    })
  }

  if (graphProfile === 'type-only-contracts') {
    if (layerGraph.rules?.layerZeroMayHaveExternalRuntimeDeps !== false) {
      violations.push({ type: 'type-only-runtime-deps-allowed' })
    }

    if (layerZeroHasExternalRuntimeDeps(layerZero)) {
      violations.push({ type: 'type-only-layer-has-runtime-deps' })
    }
  }

  if (graphProfile === 'leaf-runtime-primitives' && layerGraph.rules?.layerZeroMayHaveExternalRuntimeDeps !== true) {
    violations.push({ type: 'leaf-runtime-deps-not-declared' })
  }

  return violations
}

const layerZeroGovernanceViolations = collectLayerZeroGovernanceViolations()

// Build short-name -> layerId map. Short names are the part after "@dzupagent/"
// or the literal package name for unscoped packages (e.g. "create-dzupagent").
const shortNameToLayerId = new Map()
const shortNameToLayerName = new Map()
for (const layer of layerGraph.layers) {
  for (const shortName of layer.packages) {
    if (shortNameToLayerId.has(shortName)) {
      console.error(`Layer graph duplicates package "${shortName}".`)
      process.exit(2)
    }
    shortNameToLayerId.set(shortName, layer.id)
    shortNameToLayerName.set(shortName, layer.name)
  }
}

function shortNameOf(pkgName) {
  // "@dzupagent/core" -> "core" ; "create-dzupagent" -> "create-dzupagent"
  if (pkgName.startsWith('@dzupagent/')) return pkgName.slice('@dzupagent/'.length)
  return pkgName
}

// ---------------------------------------------------------------------------
// Section 4 — Missing-from-policy check
// ---------------------------------------------------------------------------

const missingFromTiers = []
const missingFromLayerGraph = []

for (const pkg of workspacePackages) {
  if (!pkg.name) continue

  if (!Object.prototype.hasOwnProperty.call(tiersConfig, pkg.name)) {
    missingFromTiers.push(pkg.name)
  }

  const shortName = shortNameOf(pkg.name)
  if (!shortNameToLayerId.has(shortName)) {
    missingFromLayerGraph.push(pkg.name)
  }
}

// ---------------------------------------------------------------------------
// Section 5 — Layer-graph dependency direction check
// ---------------------------------------------------------------------------

const layerViolations = []

for (const pkg of workspacePackages) {
  if (!pkg.name) continue
  const shortName = shortNameOf(pkg.name)
  const importerLayer = shortNameToLayerId.get(shortName)
  if (importerLayer === undefined) continue // already reported as missing

  for (const depName of Object.keys(pkg.runtimeDeps)) {
    if (!depName.startsWith('@dzupagent/') && depName !== 'create-dzupagent') {
      continue
    }
    const depShort = shortNameOf(depName)
    const depLayer = shortNameToLayerId.get(depShort)
    if (depLayer === undefined) continue // missing-from-policy already reported

    const allowSame = layerGraph.rules?.allowSameLayerEdges === true
    if (depLayer > importerLayer || (depLayer === importerLayer && !allowSame)) {
      layerViolations.push({
        importer: pkg.name,
        importerLayer,
        importerLayerName: shortNameToLayerName.get(shortName),
        dep: depName,
        depLayer,
        depLayerName: shortNameToLayerName.get(depShort),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Section 6 — Tooling-not-upstream-of-supported check
// ---------------------------------------------------------------------------

const toolingLayerId = layerGraph.rules?.toolingLayerId
const supportedTiers = new Set(layerGraph.rules?.supportedTiers ?? [1, 2])

const toolingUpstreamViolations = []
if (toolingLayerId !== undefined && layerGraph.rules?.toolingMayBeUpstreamOfSupported === false) {
  for (const pkg of workspacePackages) {
    if (!pkg.name) continue
    const tierEntry = tiersConfig[pkg.name]
    if (!tierEntry || !supportedTiers.has(tierEntry.tier)) continue

    for (const depName of Object.keys(pkg.runtimeDeps)) {
      if (!depName.startsWith('@dzupagent/') && depName !== 'create-dzupagent') {
        continue
      }
      const depShort = shortNameOf(depName)
      const depLayer = shortNameToLayerId.get(depShort)
      if (depLayer === toolingLayerId) {
        toolingUpstreamViolations.push({
          importer: pkg.name,
          importerTier: tierEntry.tier,
          dep: depName,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Section 7 — Runtime dependency cycle detection
// ---------------------------------------------------------------------------

/**
 * Build adjacency list: short-name -> set of short-name dependencies (only
 * @dzupagent / create-dzupagent runtime deps).
 */
function buildDependencyGraph(packages) {
  const graph = new Map()
  for (const pkg of packages) {
    if (!pkg.name) continue
    const shortName = shortNameOf(pkg.name)
    const edges = new Set()
    for (const depName of Object.keys(pkg.runtimeDeps)) {
      if (!depName.startsWith('@dzupagent/') && depName !== 'create-dzupagent') continue
      edges.add(shortNameOf(depName))
    }
    graph.set(shortName, edges)
  }
  return graph
}

/**
 * Find all simple cycles in a directed graph using iterative DFS with a
 * recursion stack. Returns an array of cycle node lists (each list begins
 * and ends with the same node).
 */
function findCycles(graph) {
  const cycles = []
  const visited = new Set()
  const stack = []
  const onStack = new Set()

  function dfs(node) {
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (onStack.has(next)) {
        const idx = stack.indexOf(next)
        const cycle = stack.slice(idx).concat(next)
        cycles.push(cycle)
        continue
      }
      if (!visited.has(next)) {
        dfs(next)
      }
    }
    stack.pop()
    onStack.delete(node)
    visited.add(node)
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node)
    }
  }

  // Deduplicate cycles by canonical rotation
  const dedup = new Map()
  for (const cycle of cycles) {
    const ring = cycle.slice(0, -1) // drop repeated last node
    const minIdx = ring.indexOf([...ring].sort()[0])
    const rotated = ring.slice(minIdx).concat(ring.slice(0, minIdx))
    const key = rotated.join('->')
    if (!dedup.has(key)) {
      dedup.set(key, rotated.concat(rotated[0]))
    }
  }
  return [...dedup.values()]
}

const dependencyGraph = buildDependencyGraph(workspacePackages)
const cycles = findCycles(dependencyGraph)

// ---------------------------------------------------------------------------
// Section 8 — Source import -> package manifest check
// ---------------------------------------------------------------------------

function isProductionSourceFile(filePath) {
  if (!/\.(?:c|m)?[jt]sx?$/.test(filePath)) return false
  if (/\.d\.[cm]?ts$/.test(filePath)) return false
  if (/(?:^|\/)__tests__(?:\/|$)/.test(filePath)) return false
  if (/\.(?:test|spec)\.(?:c|m)?[jt]sx?$/.test(filePath)) return false
  return true
}

function listProductionSourceFiles(srcDir) {
  if (!existsSync(srcDir)) return []
  const files = []

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        if (entry === 'dist' || entry === 'node_modules' || entry === '__tests__') continue
        walk(fullPath)
      } else if (stat.isFile() && isProductionSourceFile(fullPath.replaceAll('\\', '/'))) {
        files.push(fullPath)
      }
    }
  }

  walk(srcDir)
  return files
}

function maskCommentsAndTemplatesPreserveLines(source) {
  const chars = [...source]
  let state = 'code'
  let escaped = false

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]

    if (state === 'lineComment') {
      if (char === '\n') {
        state = 'code'
      } else {
        chars[index] = ' '
      }
      continue
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'code'
      } else if (char !== '\n') {
        chars[index] = ' '
      }
      continue
    }

    if (state === 'template') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '`') {
        state = 'code'
      }
      if (char !== '\n') chars[index] = ' '
      continue
    }

    if (state === 'singleQuote' || state === 'doubleQuote') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (
        (state === 'singleQuote' && char === "'")
        || (state === 'doubleQuote' && char === '"')
      ) {
        state = 'code'
      }
      continue
    }

    if (char === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'lineComment'
      continue
    }
    if (char === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'blockComment'
      continue
    }
    if (char === '`') {
      chars[index] = ' '
      state = 'template'
      escaped = false
      continue
    }
    if (char === "'") {
      state = 'singleQuote'
      escaped = false
      continue
    }
    if (char === '"') {
      state = 'doubleQuote'
      escaped = false
    }
  }

  return chars.join('')
}

function sourceLineAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function workspacePackageNameFromSpecifier(specifier) {
  if (!specifier.startsWith('@dzupagent/')) return null
  const parts = specifier.split('/')
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}

function collectDzupSourceImports(source) {
  const stripped = maskCommentsAndTemplatesPreserveLines(source)
  const imports = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"](@dzupagent\/[^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]+?\s+from\s*['"](@dzupagent\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](@dzupagent\/[^'"]+)['"]\s*\)/g,
    /\brequire(?:\.resolve)?\s*\(\s*['"](@dzupagent\/[^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(stripped)) !== null) {
      imports.push({
        packageName: workspacePackageNameFromSpecifier(match[1]),
        specifier: match[1],
        line: sourceLineAt(stripped, match.index),
      })
    }
  }

  return imports.filter((entry) => entry.packageName !== null)
}

function collectSourceImportManifestViolations(packages) {
  const workspacePackageNames = new Set(packages.map((pkg) => pkg.name).filter(Boolean))
  const violations = []

  for (const pkg of packages) {
    if (!pkg.name) continue
    const sourceFiles = listProductionSourceFiles(join(pkg.root, 'src'))

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')
      for (const sourceImport of collectDzupSourceImports(source)) {
        if (sourceImport.packageName === pkg.name) continue
        if (!workspacePackageNames.has(sourceImport.packageName)) continue
        if (Object.prototype.hasOwnProperty.call(pkg.sourceDeclaredDeps, sourceImport.packageName)) {
          continue
        }

        violations.push({
          importer: pkg.name,
          dep: sourceImport.packageName,
          specifier: sourceImport.specifier,
          file: file.replace(repoRoot + '/', ''),
          line: sourceImport.line,
        })
      }
    }
  }

  return violations
}

const sourceImportManifestViolations = collectSourceImportManifestViolations(workspacePackages)

// ---------------------------------------------------------------------------
// Section 9 — Declared package-pair source import boundary check
// ---------------------------------------------------------------------------

function buildForbiddenPackagePairRules(rules) {
  const forbiddenByImporter = new Map()

  for (const rule of rules) {
    if (!rule || typeof rule.importer !== 'string' || !Array.isArray(rule.forbidden)) {
      console.error('config/architecture-boundaries.json packageBoundaryRules entries must include importer and forbidden[].')
      process.exit(2)
    }

    const importerShortName = shortNameOf(rule.importer)
    const forbidden = forbiddenByImporter.get(importerShortName) ?? new Set()
    for (const depShortName of rule.forbidden) {
      if (typeof depShortName !== 'string') {
        console.error('config/architecture-boundaries.json packageBoundaryRules forbidden entries must be strings.')
        process.exit(2)
      }
      forbidden.add(shortNameOf(depShortName))
    }

    forbiddenByImporter.set(importerShortName, forbidden)
  }

  return forbiddenByImporter
}

function collectPackagePairBoundaryViolations(packages, rules) {
  const forbiddenByImporter = buildForbiddenPackagePairRules(rules)
  if (forbiddenByImporter.size === 0) return []

  const workspacePackageNames = new Set(packages.map((pkg) => pkg.name).filter(Boolean))
  const violations = []

  for (const pkg of packages) {
    if (!pkg.name) continue
    const importerShortName = shortNameOf(pkg.name)
    const forbiddenDeps = forbiddenByImporter.get(importerShortName)
    if (!forbiddenDeps) continue

    const sourceFiles = listProductionSourceFiles(join(pkg.root, 'src'))

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')
      for (const sourceImport of collectDzupSourceImports(source)) {
        if (sourceImport.packageName === pkg.name) continue
        if (!workspacePackageNames.has(sourceImport.packageName)) continue

        const depShortName = shortNameOf(sourceImport.packageName)
        if (!forbiddenDeps.has(depShortName)) continue

        violations.push({
          importer: pkg.name,
          importerShortName,
          dep: sourceImport.packageName,
          depShortName,
          specifier: sourceImport.specifier,
          file: file.replace(repoRoot + '/', ''),
          line: sourceImport.line,
        })
      }
    }
  }

  return violations
}

const packagePairBoundaryViolations = collectPackagePairBoundaryViolations(
  workspacePackages,
  packageBoundaryRules,
)

// ---------------------------------------------------------------------------
// Section 10 — Internal broad-root import policy check
// ---------------------------------------------------------------------------

function collectInternalBroadRootImportViolations(packages) {
  const policy = publicApiAllowlistsConfig.internalBroadRootImportPolicy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return []

  const targetSpecifiers = new Set(policy.targetSpecifiers ?? [])
  const enforcedFiles = new Set(policy.enforcedFiles ?? [])
  const migrationAllowlist = new Set(
    (policy.migrationAllowlist ?? []).map((entry) => `${entry.file}|${entry.specifier}`),
  )

  if (targetSpecifiers.size === 0 || enforcedFiles.size === 0) return []

  const violations = []

  for (const pkg of packages) {
    if (!pkg.name) continue
    const sourceFiles = listProductionSourceFiles(join(pkg.root, 'src'))

    for (const file of sourceFiles) {
      const relativeFile = file.replace(repoRoot + '/', '')
      if (!enforcedFiles.has(relativeFile)) continue

      const source = readFileSync(file, 'utf8')
      for (const sourceImport of collectDzupSourceImports(source)) {
        if (!targetSpecifiers.has(sourceImport.specifier)) continue

        const allowlistKey = `${relativeFile}|${sourceImport.specifier}`
        if (migrationAllowlist.has(allowlistKey)) continue

        violations.push({
          importer: pkg.name,
          specifier: sourceImport.specifier,
          file: relativeFile,
          line: sourceImport.line,
        })
      }
    }
  }

  return violations
}

const internalBroadRootImportViolations = collectInternalBroadRootImportViolations(workspacePackages)

// ---------------------------------------------------------------------------
// Section 11 — Server route product-boundary classification check
// ---------------------------------------------------------------------------

function collectServerRouteFiles() {
  const routesDir = join(repoRoot, 'packages', 'server', 'src', 'routes')
  if (!existsSync(routesDir)) return []

  return listProductionSourceFiles(routesDir)
    .map((file) => file.replace(repoRoot + '/', ''))
    .sort()
}

function collectServerRouteBoundaryState() {
  const routeFiles = collectServerRouteFiles()
  const policy = architectureConfig.serverRouteBoundaries
  const declaredFiles = new Map()
  const violations = []

  if (routeFiles.length === 0) {
    return { policy, routeFiles, declaredFiles, violations }
  }

  if (!policy || typeof policy !== 'object') {
    for (const file of routeFiles) {
      violations.push({
        type: 'missing-policy',
        file,
      })
    }
    return { policy, routeFiles, declaredFiles, violations }
  }

  const routeFileClassifications = policy.routeFileClassifications
  if (!routeFileClassifications || typeof routeFileClassifications !== 'object' || Array.isArray(routeFileClassifications)) {
    for (const file of routeFiles) {
      violations.push({
        type: 'missing-policy',
        file,
      })
    }
    return { policy, routeFiles, declaredFiles, violations }
  }

  for (const [category, entry] of Object.entries(routeFileClassifications)) {
    if (!SERVER_ROUTE_BOUNDARY_CATEGORIES.has(category)) {
      violations.push({
        type: 'invalid-category',
        category,
      })
      continue
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      violations.push({
        type: 'invalid-entry',
        category,
      })
      continue
    }

    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 20) {
      violations.push({
        type: 'missing-rationale',
        category,
      })
    }

    if (!Array.isArray(entry.files)) {
      violations.push({
        type: 'invalid-files',
        category,
      })
      continue
    }

    for (const file of entry.files) {
      if (typeof file !== 'string' || !file.startsWith('packages/server/src/routes/')) {
        violations.push({
          type: 'invalid-file-entry',
          category,
          file,
        })
        continue
      }

      if (declaredFiles.has(file)) {
        violations.push({
          type: 'duplicate-file',
          file,
          firstCategory: declaredFiles.get(file),
          category,
        })
        continue
      }

      declaredFiles.set(file, category)
    }
  }

  const actualRouteFiles = new Set(routeFiles)
  for (const file of routeFiles) {
    if (!declaredFiles.has(file)) {
      violations.push({
        type: 'unclassified-route-file',
        file,
      })
    }
  }

  for (const [file, category] of declaredFiles.entries()) {
    if (!actualRouteFiles.has(file)) {
      violations.push({
        type: 'stale-classification',
        file,
        category,
      })
    }
  }

  return { policy, routeFiles, declaredFiles, violations }
}

const serverRouteBoundaryState = collectServerRouteBoundaryState()
const serverRouteBoundaryViolations = serverRouteBoundaryState.violations

function maskCommentsPreserveStrings(source) {
  const chars = [...source]
  let state = 'code'

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]

    if (state === 'lineComment') {
      if (char === '\n') {
        state = 'code'
      } else {
        chars[index] = ' '
      }
      continue
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'code'
      } else if (char !== '\n') {
        chars[index] = ' '
      }
      continue
    }

    if (char === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'lineComment'
      continue
    }
    if (char === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'blockComment'
    }
  }

  return chars.join('')
}

function collectHonoRouteEndpoints(source) {
  const stripped = maskCommentsPreserveStrings(source)
  const endpoints = []
  const routePattern = /\bapp\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"])([^'"`]+)\2/g

  let match
  while ((match = routePattern.exec(stripped)) !== null) {
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[3],
      line: sourceLineAt(stripped, match.index),
    })
  }

  const onPattern = /\bapp\s*\.\s*on\s*\(\s*(['"])(GET|POST|PUT|PATCH|DELETE|ALL)\1\s*,\s*(['"])([^'"`]+)\3/gi
  while ((match = onPattern.exec(stripped)) !== null) {
    endpoints.push({
      method: match[2].toUpperCase(),
      path: match[4],
      line: sourceLineAt(stripped, match.index),
    })
  }

  return endpoints.sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)))
}

function endpointKey(endpoint) {
  return `${endpoint.method} ${endpoint.path}`
}

function endpointDisplay(endpoint) {
  return `${endpoint.method} ${endpoint.path}`
}

function normalizeMountPath(mount, endpointPath) {
  if (mount === '') return endpointPath
  if (endpointPath === '/') return mount
  if (mount.endsWith('/') && endpointPath.startsWith('/')) return `${mount.slice(0, -1)}${endpointPath}`
  if (!mount.endsWith('/') && !endpointPath.startsWith('/')) return `${mount}/${endpointPath}`
  return `${mount}${endpointPath}`
}

function normalizeEndpointEntry(entry) {
  if (typeof entry === 'string') {
    const match = /^(GET|POST|PUT|PATCH|DELETE|ALL)\s+(.+)$/i.exec(entry.trim())
    if (!match) return null
    return {
      method: match[1].toUpperCase(),
      path: match[2],
      mountedPaths: undefined,
    }
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (typeof entry.method !== 'string' || typeof entry.path !== 'string') return null

  const method = entry.method.toUpperCase()
  if (!HONO_ROUTE_METHODS.has(method)) return null

  return {
    method,
    path: entry.path,
    mountedPaths: Array.isArray(entry.mountedPaths)
      ? entry.mountedPaths.filter((mountedPath) => typeof mountedPath === 'string')
      : undefined,
  }
}

function collectServerRouteEndpointManifestViolations(state) {
  const { policy, routeFiles, declaredFiles } = state
  if (routeFiles.length === 0) return []

  const violations = []
  const manifest = policy?.routeEndpointManifest
  const manifestFiles = manifest?.files
  if (!manifest || typeof manifest !== 'object' || !manifestFiles || typeof manifestFiles !== 'object' || Array.isArray(manifestFiles)) {
    return routeFiles
      .filter((file) => collectHonoRouteEndpoints(readFileSync(join(repoRoot, file), 'utf8')).length > 0)
      .map((file) => ({
        type: 'missing-endpoint-manifest',
        file,
      }))
  }

  const routeFileSet = new Set(routeFiles)

  for (const file of routeFiles) {
    const source = readFileSync(join(repoRoot, file), 'utf8')
    const actualEndpoints = collectHonoRouteEndpoints(source)
    const entry = manifestFiles[file]

    if (actualEndpoints.length === 0) {
      if (entry) {
        violations.push({
          type: 'stale-endpoint-manifest',
          file,
        })
      }
      continue
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      violations.push({
        type: 'missing-endpoint-file',
        file,
      })
      continue
    }

    const classifiedCategory = declaredFiles.get(file)
    if (entry.category !== classifiedCategory) {
      violations.push({
        type: 'endpoint-category-mismatch',
        file,
        expected: classifiedCategory,
        actual: entry.category,
      })
    }

    if (!Array.isArray(entry.mounts) || !entry.mounts.every((mount) => typeof mount === 'string')) {
      violations.push({
        type: 'invalid-endpoint-mounts',
        file,
      })
    }

    if (
      entry.mountedEndpoints !== undefined
      && (!Array.isArray(entry.mountedEndpoints) || !entry.mountedEndpoints.every((endpoint) => typeof endpoint === 'string'))
    ) {
      violations.push({
        type: 'invalid-mounted-endpoints',
        file,
      })
    }

    if (!Array.isArray(entry.endpoints)) {
      violations.push({
        type: 'invalid-endpoint-list',
        file,
      })
      continue
    }

    const declaredEndpoints = new Map()
    for (const endpointEntry of entry.endpoints) {
      const normalized = normalizeEndpointEntry(endpointEntry)
      if (!normalized) {
        violations.push({
          type: 'invalid-endpoint-entry',
          file,
          entry: endpointEntry,
        })
        continue
      }

      const key = endpointKey(normalized)
      if (declaredEndpoints.has(key)) {
        violations.push({
          type: 'duplicate-endpoint',
          file,
          endpoint: key,
        })
        continue
      }
      declaredEndpoints.set(key, normalized)
    }

    const actualKeys = new Set(actualEndpoints.map(endpointKey))
    for (const endpoint of actualEndpoints) {
      const key = endpointKey(endpoint)
      if (!declaredEndpoints.has(key)) {
        violations.push({
          type: 'unreviewed-endpoint',
          file,
          endpoint: endpointDisplay(endpoint),
          line: endpoint.line,
        })
      }
    }

    for (const [key, endpoint] of declaredEndpoints.entries()) {
      if (!actualKeys.has(key)) {
        violations.push({
          type: 'stale-endpoint',
          file,
          endpoint: endpointDisplay(endpoint),
        })
      }

      if (entry.mounts?.length > 0 && endpoint.mountedPaths) {
        const expectedMountedPaths = entry.mounts.map((mount) => normalizeMountPath(mount, endpoint.path)).sort()
        const actualMountedPaths = [...endpoint.mountedPaths].sort()
        if (expectedMountedPaths.join('\n') !== actualMountedPaths.join('\n')) {
          violations.push({
            type: 'mounted-path-mismatch',
            file,
            endpoint: endpointDisplay(endpoint),
            expected: expectedMountedPaths,
            actual: actualMountedPaths,
          })
        }
      }
    }

    if (entry.mounts?.length > 0 && entry.mountedEndpoints) {
      const expectedMountedEndpoints = actualEndpoints
        .flatMap((endpoint) => entry.mounts.map((mount) => `${endpoint.method} ${normalizeMountPath(mount, endpoint.path)}`))
        .sort()
      const actualMountedEndpoints = [...entry.mountedEndpoints].sort()
      if (expectedMountedEndpoints.join('\n') !== actualMountedEndpoints.join('\n')) {
        violations.push({
          type: 'mounted-endpoints-mismatch',
          file,
          expected: expectedMountedEndpoints,
          actual: actualMountedEndpoints,
        })
      }
    }
  }

  for (const file of Object.keys(manifestFiles)) {
    if (!routeFileSet.has(file)) {
      violations.push({
        type: 'stale-endpoint-file',
        file,
      })
    }
  }

  return violations
}

const serverRouteEndpointManifestViolations = collectServerRouteEndpointManifestViolations(serverRouteBoundaryState)

function readInterfaceBody(source, interfaceName) {
  const match = new RegExp(`\\bexport\\s+interface\\s+${interfaceName}\\b`).exec(source)
  if (!match) return null

  const start = source.indexOf('{', match.index)
  if (start === -1) return null

  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start + 1, index)
    }
  }

  return null
}

function collectInterfacePropertyNames(source, interfaceName) {
  const body = readInterfaceBody(source, interfaceName)
  if (body === null) return null

  const props = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const match = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line)
      if (match) props.push(match[1])
    }
    for (const char of line) {
      if (char === '{') depth += 1
      if (char === '}') depth = Math.max(0, depth - 1)
    }
  }
  return props.sort()
}

function collectForgeRouteFamilyManifestViolations() {
  const policy = architectureConfig.serverRouteBoundaries?.forgeServerConfigRouteFamilies
  if (!policy) return []
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return [{ type: 'invalid-route-family-policy' }]
  }
  if (typeof policy.sourceFile !== 'string' || !policy.sourceFile.startsWith('packages/server/src/')) {
    return [{ type: 'invalid-route-family-source' }]
  }
  if (!policy.interfaces || typeof policy.interfaces !== 'object' || Array.isArray(policy.interfaces)) {
    return [{ type: 'invalid-route-family-interfaces' }]
  }

  const sourcePath = join(repoRoot, policy.sourceFile)
  if (!existsSync(sourcePath)) {
    return [{ type: 'missing-route-family-source', file: policy.sourceFile }]
  }

  const source = readFileSync(sourcePath, 'utf8')
  const violations = []
  for (const [interfaceName, declaredProps] of Object.entries(policy.interfaces)) {
    if (!Array.isArray(declaredProps) || !declaredProps.every((prop) => typeof prop === 'string')) {
      violations.push({ type: 'invalid-route-family-entry', interfaceName })
      continue
    }

    const actualProps = collectInterfacePropertyNames(source, interfaceName)
    if (actualProps === null) {
      violations.push({ type: 'missing-route-family-interface', interfaceName })
      continue
    }

    const declared = [...declaredProps].sort()
    const missing = actualProps.filter((prop) => !declared.includes(prop))
    const stale = declared.filter((prop) => !actualProps.includes(prop))
    if (missing.length > 0 || stale.length > 0) {
      violations.push({
        type: 'route-family-drift',
        interfaceName,
        missing,
        stale,
      })
    }
  }

  return violations
}

const forgeRouteFamilyManifestViolations = collectForgeRouteFamilyManifestViolations()

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failed = false

if (domainViolations.length > 0) {
  failed = true
  console.error('DOMAIN BOUNDARY VIOLATIONS DETECTED')
  console.error('======================================')
  console.error('The following universal packages import domain-specific packages')
  console.error('that have been moved out of dzupagent. This violates the architectural')
  console.error('boundary defined in DZUPAGENT_REFACTORING.md.\n')

  for (const { pkg, file } of domainViolations) {
    console.error(`  FORBIDDEN: import of "${pkg}"`)
    console.error(`  FILE:      ${file.replace(repoRoot + '/', '')}`)
    console.error()
  }

  console.error('How to fix:')
  console.error('  - If the import is in production code, move the logic to the owning app package.')
  console.error('  - If the import is in a compatibility shim, it belongs in packages/shims/, not in a universal package src/.')
  console.error('  - See DZUPAGENT_REFACTORING.md §8 for boundary contracts.')
  console.error()
}

if (missingFromTiers.length > 0 || missingFromLayerGraph.length > 0) {
  failed = true
  console.error('PACKAGE-CLASSIFICATION POLICY VIOLATIONS')
  console.error('========================================')
  console.error('Every workspace package under packages/ must be classified in BOTH')
  console.error('config/package-tiers.json and the layerGraph in')
  console.error('config/architecture-boundaries.json. The following packages are missing:\n')
  if (missingFromTiers.length > 0) {
    console.error('  Missing from config/package-tiers.json:')
    for (const name of missingFromTiers) {
      console.error(`    - ${name}`)
    }
    console.error()
  }
  if (missingFromLayerGraph.length > 0) {
    console.error('  Missing from config/architecture-boundaries.json layerGraph:')
    for (const name of missingFromLayerGraph) {
      console.error(`    - ${name}`)
    }
    console.error()
  }
  console.error('How to fix:')
  console.error('  - Pick the smallest tier that reflects who depends on the package.')
  console.error('  - Pick the lowest layer that contains all of the package\'s runtime deps.')
  console.error('  - Add an entry to BOTH config files. Tier metadata is owned by package-tiers.json.')
  console.error()
}

if (layerZeroGovernanceViolations.length > 0) {
  failed = true
  console.error('LAYER-0 RUNTIME-PROFILE GOVERNANCE VIOLATIONS')
  console.error('================================================')
  console.error('Layer 0 must declare whether it is type-only or leaf-runtime capable,')
  console.error('and its name/description must match that decision.\n')

  for (const v of layerZeroGovernanceViolations) {
    if (v.type === 'missing-layer-zero') {
      console.error('  MISSING: layerGraph.layers has no id=0 entry.')
    } else if (v.type === 'invalid-runtime-profile') {
      console.error(`  INVALID PROFILE: rules.layerZeroRuntimeProfile=${String(v.value)}`)
    } else if (v.type === 'runtime-profile-mismatch') {
      console.error(
        `  PROFILE MISMATCH: layer 0 runtimeProfile=${String(v.layerProfile)} but rules.layerZeroRuntimeProfile=${String(v.graphProfile)}`,
      )
    } else if (v.type === 'leaf-runtime-type-only-label') {
      console.error(`  LABEL MISMATCH: layer 0 "${String(v.layerName)}" is leaf-runtime capable but still uses type-only wording.`)
    } else if (v.type === 'type-only-runtime-deps-allowed') {
      console.error('  POLICY MISMATCH: type-only layer 0 must set layerZeroMayHaveExternalRuntimeDeps=false.')
    } else if (v.type === 'type-only-layer-has-runtime-deps') {
      console.error('  RUNTIME DEP MISMATCH: type-only layer 0 contains packages with external runtime dependencies.')
    } else if (v.type === 'leaf-runtime-deps-not-declared') {
      console.error('  POLICY MISMATCH: leaf-runtime layer 0 must set layerZeroMayHaveExternalRuntimeDeps=true.')
    }
  }

  console.error()
  console.error('How to fix:')
  console.error('  - Use layerZeroRuntimeProfile="leaf-runtime-primitives" when layer 0 contains parsers, validators, IPC, or cache implementations.')
  console.error('  - Use layerZeroRuntimeProfile="type-only-contracts" only when layer 0 has no runtime dependency burden.')
  console.error('  - Keep layer 0 free of @dzupagent runtime dependencies; the layer-direction check enforces that separately.')
  console.error()
}

if (layerViolations.length > 0) {
  failed = true
  console.error('LAYER-GRAPH DIRECTION VIOLATIONS')
  console.error('================================')
  console.error('Each package may only depend on packages in strictly lower-numbered layers.\n')
  for (const v of layerViolations) {
    console.error(`  FORBIDDEN: ${v.importer} (layer ${v.importerLayer}/${v.importerLayerName})`)
    console.error(`             -> ${v.dep} (layer ${v.depLayer}/${v.depLayerName})`)
  }
  console.error()
}

if (toolingUpstreamViolations.length > 0) {
  failed = true
  console.error('TOOLING-UPSTREAM VIOLATIONS')
  console.error('===========================')
  console.error('Tier-1 and tier-2 supported packages must not take a runtime dependency on')
  console.error('a tier-3 tooling/parked package.\n')
  for (const v of toolingUpstreamViolations) {
    console.error(`  FORBIDDEN: ${v.importer} (tier ${v.importerTier}) -> ${v.dep} (tooling)`)
  }
  console.error()
}

if (cycles.length > 0) {
  failed = true
  console.error('PACKAGE DEPENDENCY CYCLE DETECTED')
  console.error('=================================')
  console.error('The runtime dependency graph (dependencies + peerDependencies in package.json)')
  console.error('must be acyclic. Found:')
  console.error()
  for (const cycle of cycles) {
    console.error(`  CYCLE: ${cycle.join(' -> ')}`)
  }
  console.error()
}

if (sourceImportManifestViolations.length > 0) {
  failed = true
  console.error('SOURCE IMPORT MANIFEST DEPENDENCY VIOLATIONS')
  console.error('================================================')
  console.error('Production src/** imports from sibling @dzupagent/* workspace packages')
  console.error(`must be declared in one of: ${SOURCE_IMPORT_MANIFEST_FIELDS.join(', ')}.`)
  console.error('Type-only imports are not exempt because emitted declaration files expose')
  console.error('the imported package contract.\n')

  for (const v of sourceImportManifestViolations) {
    console.error(`  MISSING: ${v.importer} imports ${v.dep}`)
    console.error(`  FILE:    ${v.file}:${v.line}`)
    console.error(`  SOURCE:  ${v.specifier}`)
    console.error()
  }

  console.error('How to fix:')
  console.error('  - Add the sibling package to dependencies, peerDependencies, or optionalDependencies.')
  console.error('  - Or route the import through an already-declared framework contract.')
  console.error()
}

if (packagePairBoundaryViolations.length > 0) {
  failed = true
  console.error('PACKAGE-PAIR BOUNDARY VIOLATIONS')
  console.error('================================')
  console.error('Production src/** imports from sibling @dzupagent/* workspace packages')
  console.error('must not violate packageBoundaryRules declared in')
  console.error('config/architecture-boundaries.json.\n')

  for (const v of packagePairBoundaryViolations) {
    console.error(`  FORBIDDEN: ${v.importer} (${v.importerShortName}) imports ${v.dep} (${v.depShortName})`)
    console.error(`  FILE:      ${v.file}:${v.line}`)
    console.error(`  SOURCE:    ${v.specifier}`)
    console.error()
  }

  console.error('How to fix:')
  console.error('  - Move the dependency behind a lower-level shared contract package.')
  console.error('  - Or update packageBoundaryRules only if the architecture decision changed.')
  console.error()
}

if (internalBroadRootImportViolations.length > 0) {
  failed = true
  console.error('INTERNAL BROAD ROOT IMPORT VIOLATIONS')
  console.error('=====================================')
  console.error('Selected internal source files must not import broad package roots')
  console.error('without an explicit migration allowlist entry in config/public-api-allowlists.json.\n')

  for (const v of internalBroadRootImportViolations) {
    console.error(`  FORBIDDEN: ${v.importer} imports ${v.specifier}`)
    console.error(`  FILE:      ${v.file}:${v.line}`)
    console.error()
  }

  console.error('How to fix:')
  console.error('  - Prefer an existing stable subpath import such as /runtime, /orchestration, or /quick-start.')
  console.error('  - If no safe subpath exists in this slice, add a specific migrationAllowlist entry.')
  console.error()
}

if (serverRouteBoundaryViolations.length > 0) {
  failed = true
  console.error('SERVER ROUTE PRODUCT-BOUNDARY VIOLATIONS')
  console.error('========================================')
  console.error('Production files under packages/server/src/routes/** must be declared in')
  console.error('config/architecture-boundaries.json serverRouteBoundaries.routeFileClassifications.')
  console.error('Allowed categories are:')
  console.error('  - compatibility-maintenance')
  console.error('  - framework-primitive')
  console.error('  - route-plugin-host-seam')
  console.error('  - internal-support')
  console.error()

  for (const v of serverRouteBoundaryViolations) {
    if (v.type === 'missing-policy') {
      console.error(`  MISSING POLICY: ${v.file}`)
    } else if (v.type === 'invalid-category') {
      console.error(`  INVALID CATEGORY: ${v.category}`)
    } else if (v.type === 'invalid-entry') {
      console.error(`  INVALID ENTRY: ${v.category} must be an object.`)
    } else if (v.type === 'missing-rationale') {
      console.error(`  MISSING RATIONALE: ${v.category} needs a non-empty rationale.`)
    } else if (v.type === 'invalid-files') {
      console.error(`  INVALID FILES: ${v.category}.files must be an array.`)
    } else if (v.type === 'invalid-file-entry') {
      console.error(`  INVALID FILE ENTRY: ${v.category} declares ${String(v.file)}`)
    } else if (v.type === 'duplicate-file') {
      console.error(`  DUPLICATE: ${v.file} declared as ${v.firstCategory} and ${v.category}`)
    } else if (v.type === 'unclassified-route-file') {
      console.error(`  UNCLASSIFIED ROUTE FILE: ${v.file}`)
    } else if (v.type === 'stale-classification') {
      console.error(`  STALE CLASSIFICATION: ${v.file} (${v.category}) no longer exists.`)
    }
  }

  console.error()
  console.error('How to fix:')
  console.error('  - Prefer moving new product-control-plane routes into the consuming app.')
  console.error('  - Use routePlugins or app-owned Hono composition for app/product routes.')
  console.error('  - Only add a server route file when it is framework primitive, compatibility/maintenance,')
  console.error('    a route-plugin host seam, or internal support; then classify it with a rationale.')
  console.error()
}

if (serverRouteEndpointManifestViolations.length > 0) {
  failed = true
  console.error('SERVER ROUTE ENDPOINT-MANIFEST VIOLATIONS')
  console.error('=========================================')
  console.error('Hono method/path declarations inside packages/server/src/routes/** must')
  console.error('match config/architecture-boundaries.json serverRouteBoundaries.routeEndpointManifest.')
  console.error('The manifest records reviewed route ownership categories and mounted path pairs')
  console.error('so classified route files cannot grow endpoints without explicit review.\n')

  for (const v of serverRouteEndpointManifestViolations) {
    if (v.type === 'missing-endpoint-manifest') {
      console.error(`  MISSING ENDPOINT MANIFEST: ${v.file}`)
    } else if (v.type === 'missing-endpoint-file') {
      console.error(`  MISSING ENDPOINT FILE ENTRY: ${v.file}`)
    } else if (v.type === 'stale-endpoint-manifest') {
      console.error(`  STALE ENDPOINT MANIFEST: ${v.file} no longer declares route endpoints.`)
    } else if (v.type === 'stale-endpoint-file') {
      console.error(`  STALE ENDPOINT FILE ENTRY: ${v.file}`)
    } else if (v.type === 'endpoint-category-mismatch') {
      console.error(`  CATEGORY MISMATCH: ${v.file} expected ${v.expected}, found ${String(v.actual)}`)
    } else if (v.type === 'invalid-endpoint-mounts') {
      console.error(`  INVALID MOUNTS: ${v.file}.mounts must be an array of strings.`)
    } else if (v.type === 'invalid-mounted-endpoints') {
      console.error(`  INVALID MOUNTED ENDPOINTS: ${v.file}.mountedEndpoints must be an array of strings.`)
    } else if (v.type === 'invalid-endpoint-list') {
      console.error(`  INVALID ENDPOINTS: ${v.file}.endpoints must be an array.`)
    } else if (v.type === 'invalid-endpoint-entry') {
      console.error(`  INVALID ENDPOINT ENTRY: ${v.file} declares ${JSON.stringify(v.entry)}`)
    } else if (v.type === 'duplicate-endpoint') {
      console.error(`  DUPLICATE ENDPOINT: ${v.file} ${v.endpoint}`)
    } else if (v.type === 'unreviewed-endpoint') {
      console.error(`  UNREVIEWED ENDPOINT: ${v.file}:${v.line} ${v.endpoint}`)
    } else if (v.type === 'stale-endpoint') {
      console.error(`  STALE ENDPOINT: ${v.file} ${v.endpoint}`)
    } else if (v.type === 'mounted-path-mismatch') {
      console.error(`  MOUNTED PATH MISMATCH: ${v.file} ${v.endpoint}`)
      console.error(`    expected: ${v.expected.join(', ')}`)
      console.error(`    actual:   ${v.actual.join(', ')}`)
    } else if (v.type === 'mounted-endpoints-mismatch') {
      console.error(`  MOUNTED ENDPOINTS MISMATCH: ${v.file}`)
      console.error(`    expected: ${v.expected.join(', ')}`)
      console.error(`    actual:   ${v.actual.join(', ')}`)
    }
  }

  console.error()
  console.error('How to fix:')
  console.error('  - Prefer moving new product-control-plane endpoints into the consuming app.')
  console.error('  - If the endpoint is a reviewed framework/compatibility route, update')
  console.error('    routeEndpointManifest with its method/path, ownership category, and mounted path.')
  console.error()
}

if (forgeRouteFamilyManifestViolations.length > 0) {
  failed = true
  console.error('FORGE SERVER CONFIG ROUTE-FAMILY REVIEW VIOLATIONS')
  console.error('==================================================')
  console.error('ForgeServerConfig route-family fields must match')
  console.error('serverRouteBoundaries.forgeServerConfigRouteFamilies before built-in')
  console.error('server route families grow.\n')

  for (const v of forgeRouteFamilyManifestViolations) {
    if (v.type === 'invalid-route-family-policy') {
      console.error('  INVALID ROUTE-FAMILY POLICY: expected an object.')
    } else if (v.type === 'invalid-route-family-source') {
      console.error('  INVALID ROUTE-FAMILY SOURCE: sourceFile must be a packages/server/src path.')
    } else if (v.type === 'invalid-route-family-interfaces') {
      console.error('  INVALID ROUTE-FAMILY INTERFACES: interfaces must be an object.')
    } else if (v.type === 'missing-route-family-source') {
      console.error(`  MISSING ROUTE-FAMILY SOURCE: ${v.file}`)
    } else if (v.type === 'invalid-route-family-entry') {
      console.error(`  INVALID ROUTE-FAMILY ENTRY: ${v.interfaceName} must list property names.`)
    } else if (v.type === 'missing-route-family-interface') {
      console.error(`  MISSING ROUTE-FAMILY INTERFACE: ${v.interfaceName}`)
    } else if (v.type === 'route-family-drift') {
      console.error(`  ROUTE-FAMILY DRIFT: ${v.interfaceName}`)
      if (v.missing.length > 0) console.error(`    unreviewed fields: ${v.missing.join(', ')}`)
      if (v.stale.length > 0) console.error(`    stale fields: ${v.stale.join(', ')}`)
    }
  }

  console.error()
  console.error('How to fix:')
  console.error('  - Prefer routePlugins or app-owned Hono composition for product route growth.')
  console.error('  - If a built-in route-family field is retained, update the review manifest')
  console.error('    with the field and its route ownership implications.')
  console.error()
}

if (failed) {
  process.exitCode = 1
} else {
  console.log('Domain boundary check passed — no forbidden imports, missing classifications, layer-0 runtime-profile drift, layer-direction violations, tooling-upstream edges, runtime cycles, undeclared source imports, package-pair boundary violations, internal broad root import violations, unclassified server route files, unreviewed server endpoints, or route-family review drift found.')
}
