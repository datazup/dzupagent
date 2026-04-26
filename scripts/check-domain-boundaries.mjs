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
 *   3. The layer graph must be acyclic and consistent: a package may only
 *      depend on packages in strictly lower-numbered layers.
 *   4. Tier-1 and tier-2 (supported) packages MUST NOT take a runtime
 *      dependency on a tier-3 tooling/parked package.
 *   5. The runtime dependency graph (packages/<pkg>/package.json
 *      dependencies + peerDependencies) must be acyclic.
 *
 * Usage:
 *   node scripts/check-domain-boundaries.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')
const tiersConfigPath = join(repoRoot, 'config', 'package-tiers.json')
const architectureConfigPath = join(repoRoot, 'config', 'architecture-boundaries.json')

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
      runtimeDeps: {
        ...(pkgJson.dependencies || {}),
        ...(pkgJson.peerDependencies || {}),
      },
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

const layerGraph = architectureConfig.layerGraph
if (!layerGraph || !Array.isArray(layerGraph.layers)) {
  console.error('config/architecture-boundaries.json is missing a layerGraph.layers array.')
  process.exit(2)
}

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

if (failed) {
  process.exit(1)
}

console.log('Domain boundary check passed — no forbidden imports, missing classifications, layer-direction violations, tooling-upstream edges, or runtime cycles found.')
process.exit(0)
