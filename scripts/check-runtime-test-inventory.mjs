import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Capability classification (TEST-M-03 / MC-8)
// ---------------------------------------------------------------------------

/**
 * Classify a test file path into one of four capability tiers:
 *   'unit'                — pure logic, no I/O or external services
 *   'component'           — real modules but no external services
 *   'integration-external'— requires Postgres/Redis/Qdrant or Docker
 *   'e2e'                 — full-stack end-to-end
 *
 * Classification is based on filename patterns and directory markers;
 * no file content is read. Matches are checked most-specific first.
 */
export function classifyTestCapability(filePath) {
  const normalised = filePath.replace(/\\/g, '/')

  // e2e: filename contains 'e2e' segment OR lives in an e2e/ directory
  if (/(?:^|\/)e2e(?:\/|[^/]*\.test\.)/.test(normalised) || /\.e2e\.test\./.test(normalised)) {
    return 'e2e'
  }

  // integration-external: *.integration.test.ts OR lives in an integration/
  // directory, OR filename implies a real external service (postgres, bullmq,
  // redis, qdrant, testcontainer, vector-ops)
  if (
    /\.integration\.test\./.test(normalised) ||
    /(?:^|\/)integration\//.test(normalised) ||
    /(?:postgres|bullmq|redis|qdrant|testcontainer|vector-ops)/.test(normalised)
  ) {
    return 'integration-external'
  }

  // contract: exercises real module boundaries but no external services —
  // classify as 'component'
  if (/\.contract\.test\./.test(normalised) || /(?:^|\/)contract\//.test(normalised)) {
    return 'component'
  }

  // Default: unit for all other test files
  return 'unit'
}

const runtimePackageDenylist = new Set([
  'create-dzupagent',
  'test-utils',
  'testing',
  'runtime-contracts',
  // `hitl-kit` is a pure types package (payload/response shapes) with no
  // runtime logic to exercise, so it carries no test suite by design.
  'hitl-kit',
])
const runtimeCriticalPackages = new Set([
  'agent',
  'agent-adapters',
  'connectors',
  'connectors-browser',
  'connectors-documents',
  'context',
  'core',
  'evals',
  'memory',
  'memory-ipc',
  'rag',
  'scraper',
  'server',
])

// DZUPAGENT-TEST-C-13: the `--strict-integration` gate previously required a
// real-external-service integration suite from EVERY runtimeCriticalPackage,
// but "runtime-critical" (must not ship with zero unit tests / uncovered
// critical source) is a different property from "talks to a real external
// service over the network". Only these packages have an external-service
// code path that a true-integration suite (requireIntegration/skipOrFailIfNo*)
// can exercise:
//   - server: Postgres run store, Redis/BullMQ queue, tenant-scope Postgres
//   - rag:    Qdrant vector store factory
// Gating the strict requirement on the full critical set made it
// unsatisfiable by design (11 packages with no external surface can never
// grow a true-integration test), so it exited 1 on clean main and, chained
// first with `&&` in verify:strict:ci, short-circuited the entire CI job.
// Keep runtimeCriticalPackages for the zero-test / critical-source gates;
// gate --strict-integration on externalServicePackages alone.
const externalServicePackages = new Set(['server', 'rag'])

const strictIntegrationGateEnabled =
  process.argv.includes('--strict-integration') ||
  process.env.DZUPAGENT_RUNTIME_INTEGRATION_STRICT === '1' ||
  process.env.DZUPAGENT_RUNTIME_TEST_INVENTORY_STRICT === 'integration'

// Integration-style detection needs both filename and directory markers.
// Filename globs catch suites like `foo.integration.test.ts`; directory globs
// catch suites like `src/integration/foo.test.ts` and nested variants.
const integrationStyleFilenamePatterns = [
  '*integration*test.ts',
  '*integration*test.tsx',
  '*contract*test.ts',
  '*contract*test.tsx',
  '*e2e*test.ts',
  '*e2e*test.tsx',
]

const integrationStyleDirectoryPatterns = [
  '**/integration/**/*.test.ts',
  '**/integration/**/*.test.tsx',
  '**/contract/**/*.test.ts',
  '**/contract/**/*.test.tsx',
  '**/e2e/**/*.test.ts',
  '**/e2e/**/*.test.tsx',
]

const integrationStyleTestPatterns = [
  ...integrationStyleFilenamePatterns,
  ...integrationStyleDirectoryPatterns,
]

// ---------------------------------------------------------------------------
// Behavior-based integration detection (DZUPAGENT-TEST-H-02)
// ---------------------------------------------------------------------------
//
// `integrationStyleTestPatterns` above classifies by filename only, which
// over-counts: most `*.integration.test.ts` / `*e2e*test.ts` files in this
// repo exercise real cross-module wiring with mocked/in-memory dependencies
// (vi.fn, InMemoryStore, MockChatModel, ...) rather than a real external
// service. A suite only actually touches a real external service when it:
//
//   1. Calls the shared fail-closed integration gate (`requireIntegration(`,
//      `requireIntegrationEnv(`, or the server-local `skipOrFailIfNo*(`
//      wrappers — all of which exist specifically to gate suites that talk
//      to a real Postgres/Redis/container runtime), or
//   2. References the `RUN_REQUIRED_INTEGRATION` env var directly (the
//      inline fail-closed pattern used before/instead of the shared helper,
//      e.g. packages/subagents postgres-task-store-queue.test.ts).
//
// Both signals are narrow and intentional: they only appear in test files
// that were deliberately written to gate on real-service availability, so
// they have effectively no false positives (unlike matching on strings like
// "postgres" or "QDRANT_URL", which also appear in mocked unit tests that
// merely reference those names as fixture data or env var keys under test).
const trueIntegrationMarkerPattern =
  'requireIntegration\\(|requireIntegrationEnv\\(|skipOrFailIfNo(Database|Redis|ContainerRuntime)\\(|RUN_REQUIRED_INTEGRATION'

function countTrueIntegrationTestFiles(srcPath, repoRoot) {
  if (!existsSync(join(repoRoot, srcPath))) return 0
  try {
    const output = execFileSync(
      'rg',
      ['-l', '-e', trueIntegrationMarkerPattern, srcPath, '-g', '*test.ts', '-g', '*test.tsx', '-g', '*test.mjs', '-g', '*test.mts'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const trimmed = output.trim()
    return trimmed.length === 0 ? 0 : trimmed.split('\n').length
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return 0
    }
    throw error
  }
}

/**
 * Classify a test file as a "true" (behavior-based) integration suite: it
 * must actually reference the fail-closed integration gate rather than just
 * matching an integration-flavoured filename. Exported for unit testing.
 */
export function isTrueIntegrationTestFile(fileContents) {
  return new RegExp(trueIntegrationMarkerPattern).test(fileContents)
}

function createContext(repoRoot) {
  return {
    repoRoot,
    packagesDir: join(repoRoot, 'packages'),
    coverageConfigPath: join(repoRoot, 'coverage-thresholds.json'),
  }
}

function rgCount(args, repoRoot) {
  try {
    const output = execFileSync('rg', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const trimmed = output.trim()
    return trimmed.length === 0 ? 0 : trimmed.split('\n').length
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return 0
    }
    throw error
  }
}

function countTestFiles(srcPath, patterns, repoRoot) {
  const args = ['--files', srcPath]
  for (const pattern of patterns) {
    args.push('-g', pattern)
  }
  return rgCount(args, repoRoot)
}

// Some runtime packages (for example `flow-ast`, `flow-compiler`) keep their
// suites in a top-level `test/` directory rather than `src/__tests__/`. We
// scan both locations and sum the results so the inventory gate reflects the
// real suite coverage regardless of layout.
function countPackageTestFiles(packageName, patterns, context) {
  const srcPath = `packages/${packageName}/src`
  let total = countTestFiles(srcPath, patterns, context.repoRoot)

  const siblingTestDir = join(context.packagesDir, packageName, 'test')
  if (existsSync(siblingTestDir)) {
    total += countTestFiles(`packages/${packageName}/test`, patterns, context.repoRoot)
  }

  return total
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function normalizeWaiver(input) {
  if (!input || typeof input !== 'object') return null
  return {
    reason: typeof input.reason === 'string' ? input.reason.trim() : '',
    until: typeof input.until === 'string' ? input.until : null,
  }
}

function isActiveWaiver(waiver) {
  if (!waiver) return false
  if (!waiver.reason) {
    throw new Error('Critical source coverage waivers must include a reason')
  }
  if (!waiver.until) return true
  const untilTime = Date.parse(waiver.until)
  if (Number.isNaN(untilTime)) {
    throw new Error(`Invalid critical source coverage waiver until date: ${waiver.until}`)
  }
  return untilTime >= Date.now()
}

function loadCriticalSourceFiles(context) {
  const config = readJsonIfExists(context.coverageConfigPath)
  const entries = Array.isArray(config?.criticalSourceFiles) ? config.criticalSourceFiles : []

  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      packageName: typeof entry.package === 'string' ? entry.package.trim() : '',
      sourcePath: typeof entry.path === 'string' ? entry.path.trim() : '',
      coveredBy: Array.isArray(entry.coveredBy)
        ? entry.coveredBy.filter((path) => typeof path === 'string' && path.trim().length > 0)
        : [],
      waiver: normalizeWaiver(entry.waiver),
    }))
    .filter((entry) => entry.packageName.length > 0 && entry.sourcePath.length > 0)
}

function loadLargeSourceFileRiskConfig(context) {
  const config = readJsonIfExists(context.coverageConfigPath)
  const riskConfig = config?.largeSourceFileRisk && typeof config.largeSourceFileRisk === 'object'
    ? config.largeSourceFileRisk
    : {}

  return {
    minLines: typeof riskConfig.minLines === 'number' && Number.isFinite(riskConfig.minLines)
      ? riskConfig.minLines
      : 700,
    excludedPackages: new Set(
      Array.isArray(riskConfig.excludedPackages)
        ? riskConfig.excludedPackages.filter((name) => typeof name === 'string')
        : [],
    ),
  }
}

function directTestCandidates(sourcePath) {
  const extension = extname(sourcePath)
  const sourceWithoutExtension = sourcePath.slice(0, -extension.length)
  const sourceDir = dirname(sourcePath)
  const sourceBase = basename(sourceWithoutExtension)
  const withoutSrcPrefix = sourcePath.startsWith('src/') ? sourcePath.slice('src/'.length) : sourcePath
  const withoutSrcExtension = withoutSrcPrefix.slice(0, -extname(withoutSrcPrefix).length)

  return [...new Set([
    `${sourceWithoutExtension}.test${extension}`,
    join(sourceDir, '__tests__', `${sourceBase}.test${extension}`),
    join('src', '__tests__', `${withoutSrcExtension}.test${extension}`),
  ])]
}

function listProductionSourceFiles(directory) {
  if (!existsSync(directory)) return []

  const entries = readdirSync(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__fixtures__' || entry.name === '__benches__') {
        continue
      }
      files.push(...listProductionSourceFiles(entryPath))
      continue
    }

    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue
    files.push(entryPath)
  }

  return files
}

function countLines(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  if (raw.length === 0) return 0
  return raw.split('\n').length
}

function toPackageRelativePath(context, packageName, absolutePath) {
  const packageRoot = join(context.packagesDir, packageName)
  return absolutePath.slice(packageRoot.length + 1)
}

function loadDeclaredCoverageBySource(context) {
  const declared = new Map()
  for (const entry of loadCriticalSourceFiles(context)) {
    if (entry.coveredBy.length === 0) continue
    declared.set(`${entry.packageName}:${entry.sourcePath}`, entry.coveredBy)
  }
  return declared
}

function evaluateLargeSourceFileRisk(context, runtimePackages) {
  const config = loadLargeSourceFileRiskConfig(context)
  const declaredCoverage = loadDeclaredCoverageBySource(context)
  const risks = []

  for (const packageName of runtimePackages) {
    if (config.excludedPackages.has(packageName)) continue

    const sourceRoot = join(context.packagesDir, packageName, 'src')
    for (const sourceAbsolutePath of listProductionSourceFiles(sourceRoot)) {
      const sourcePath = toPackageRelativePath(context, packageName, sourceAbsolutePath)
      const lineCount = countLines(sourceAbsolutePath)
      if (lineCount < config.minLines) continue

      const directCoverage = directTestCandidates(sourcePath).filter((candidate) =>
        existsSync(join(context.packagesDir, packageName, candidate)),
      )
      const declaredCoverageFiles = declaredCoverage.get(`${packageName}:${sourcePath}`) ?? []
      const existingDeclaredCoverage = declaredCoverageFiles.filter((candidate) =>
        existsSync(join(context.packagesDir, packageName, candidate)),
      )

      if (directCoverage.length > 0 || existingDeclaredCoverage.length > 0) continue

      risks.push({
        packageName,
        sourcePath,
        lineCount,
        status: 'risk',
        message: `large production file has ${lineCount} lines and no direct or declared test coverage`,
      })
    }
  }

  return risks.sort((a, b) => b.lineCount - a.lineCount || a.packageName.localeCompare(b.packageName))
}

function evaluateCriticalSourceCoverage(context) {
  return loadCriticalSourceFiles(context).map((entry) => {
    const sourceAbsolutePath = join(context.packagesDir, entry.packageName, entry.sourcePath)
    const directCoverage = directTestCandidates(entry.sourcePath).filter((candidate) =>
      existsSync(join(context.packagesDir, entry.packageName, candidate)),
    )
    const declaredCoverage = entry.coveredBy.filter((candidate) =>
      existsSync(join(context.packagesDir, entry.packageName, candidate)),
    )
    const missingDeclaredCoverage = entry.coveredBy.filter((candidate) =>
      !existsSync(join(context.packagesDir, entry.packageName, candidate)),
    )

    if (isActiveWaiver(entry.waiver)) {
      return {
        ...entry,
        status: 'waived',
        message: entry.waiver.until
          ? `waived until ${entry.waiver.until}: ${entry.waiver.reason}`
          : `waived: ${entry.waiver.reason}`,
      }
    }

    if (!existsSync(sourceAbsolutePath)) {
      return {
        ...entry,
        status: 'fail',
        message: `critical source file does not exist: packages/${entry.packageName}/${entry.sourcePath}`,
      }
    }

    if (missingDeclaredCoverage.length > 0) {
      return {
        ...entry,
        status: 'fail',
        message: `declared coverage file missing: ${missingDeclaredCoverage.join(', ')}`,
      }
    }

    if (directCoverage.length > 0) {
      return {
        ...entry,
        status: 'pass',
        message: `direct coverage via ${directCoverage.join(', ')}`,
      }
    }

    if (declaredCoverage.length > 0) {
      return {
        ...entry,
        status: 'pass',
        message: `declared coverage via ${declaredCoverage.join(', ')}`,
      }
    }

    return {
      ...entry,
      status: 'fail',
      message: 'missing direct or declared test coverage',
    }
  })
}

export function runRuntimeTestInventory({
  repoRoot = process.cwd(),
  strictIntegration = strictIntegrationGateEnabled,
} = {}) {
  const context = createContext(repoRoot)
  const packageNames = readdirSync(context.packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const runtimePackages = packageNames.filter((name) => {
    if (runtimePackageDenylist.has(name)) return false
    return existsSync(join(context.packagesDir, name, 'src'))
  })

  const summary = runtimePackages.map((name) => {
    // TEST-H-07: include node:test `.mjs`/`.mts` suites (e.g. dialogue-core,
    // dialogue-core-replay run `node --test src/__tests__/*.test.mjs`). Globbing
    // only .ts/.tsx counted those tested packages as zero-test and false-failed.
    const testCount = countPackageTestFiles(
      name,
      ['*test.ts', '*test.tsx', '*test.mjs', '*test.mts'],
      context,
    )
    // Filename-based count — kept for visibility/backward-compat in the
    // printed report, but no longer used to gate --strict-integration since
    // it over-counts mocked "integration"-named suites (DZUPAGENT-TEST-H-02).
    const integrationStyleTestCount = countPackageTestFiles(name, integrationStyleTestPatterns, context)
    // Behavior-based count: suites that actually gate on a real external
    // service via the shared fail-closed integration helper.
    const trueIntegrationTestCount = countTrueIntegrationTestFiles(`packages/${name}/src`, context.repoRoot)
    return {
      name,
      testCount,
      integrationStyleTestCount,
      trueIntegrationTestCount,
      critical: runtimeCriticalPackages.has(name),
    }
  })

  const zeroTestFailing = summary.filter((entry) => entry.testCount === 0)
  const criticalSourceCoverage = evaluateCriticalSourceCoverage(context)
  const criticalSourceFailing = criticalSourceCoverage.filter((entry) => entry.status === 'fail')
  const largeSourceFileRisks = evaluateLargeSourceFileRisk(context, runtimePackages)
  // DZUPAGENT-TEST-C-13: require a true (real-external-service) integration
  // suite only from packages that actually have an external-service surface,
  // not from every runtime-critical package (see externalServicePackages).
  const integrationFailing = strictIntegration
    ? summary.filter(
        (entry) =>
          externalServicePackages.has(entry.name) && entry.trueIntegrationTestCount === 0,
      )
    : []
  const exitCode = zeroTestFailing.length > 0 || criticalSourceFailing.length > 0 || integrationFailing.length > 0 ? 1 : 0

  return {
    summary,
    zeroTestFailing,
    criticalSourceCoverage,
    criticalSourceFailing,
    largeSourceFileRisks,
    integrationFailing,
    strictIntegration,
    exitCode,
  }
}

function printRuntimeTestInventory(report) {
  console.log('Runtime package test inventory:')
  for (const entry of report.summary) {
    console.log(
      `- ${entry.name}: ${entry.testCount} test file${entry.testCount === 1 ? '' : 's'}, ` +
        `${entry.integrationStyleTestCount} integration-style (filename) test${entry.integrationStyleTestCount === 1 ? '' : 's'}, ` +
        `${entry.trueIntegrationTestCount} true integration (real external service) test${entry.trueIntegrationTestCount === 1 ? '' : 's'}`,
    )
  }

  if (report.zeroTestFailing.length > 0) {
    console.error('\nZero-test runtime packages detected:')
    for (const entry of report.zeroTestFailing) {
      console.error(`- ${entry.name}`)
    }
    return
  }

  console.log('\nZero-test runtime package gate passed.')

  if (report.criticalSourceCoverage.length > 0) {
    console.log('\nCritical source coverage inventory:')
    for (const entry of report.criticalSourceCoverage) {
      const line = `- ${entry.packageName}/${entry.sourcePath}: ${entry.message}`
      if (entry.status === 'fail') {
        console.error(line)
      } else {
        console.log(line)
      }
    }

    if (report.criticalSourceFailing.length > 0) {
      console.error('\nCritical source files without coverage inventory:')
      for (const entry of report.criticalSourceFailing) {
        console.error(`- ${entry.packageName}/${entry.sourcePath}: ${entry.message}`)
      }
      return
    }

    console.log('Critical source coverage inventory gate passed.')
  }

  console.log('\nLarge production file risk inventory:')
  if (report.largeSourceFileRisks.length === 0) {
    console.log('- no large production files without direct or declared test coverage found')
  } else {
    for (const entry of report.largeSourceFileRisks) {
      console.log(`- ${entry.packageName}/${entry.sourcePath}: ${entry.message}`)
    }
  }

  if (report.strictIntegration) {
    if (report.integrationFailing.length > 0) {
      console.error(
        '\nRuntime-critical packages without true integration tests ' +
          '(no suite references a real external service via the shared ' +
          'fail-closed gate — requireIntegration/skipOrFailIfNo*/RUN_REQUIRED_INTEGRATION):',
      )
      for (const entry of report.integrationFailing) {
        console.error(`- ${entry.name}`)
      }
      return
    }

    console.log('Strict true-integration runtime package gate passed.')
  }
}

// ---------------------------------------------------------------------------
// Capability-tier report (MC-8 / TEST-M-03)
// ---------------------------------------------------------------------------

/**
 * Scan test files across all runtime packages and bucket them by capability
 * tier using classifyTestCapability().  Returns a summary map:
 *   { unit: string[], component: string[], 'integration-external': string[], e2e: string[] }
 */
function buildCapabilityReport(repoRoot = process.cwd()) {
  const context = createContext(repoRoot)
  const packageNames = readdirSync(context.packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const runtimePackages = packageNames.filter((name) => {
    if (runtimePackageDenylist.has(name)) return false
    return existsSync(join(context.packagesDir, name, 'src'))
  })

  const tiers = { unit: [], component: [], 'integration-external': [], e2e: [] }

  for (const pkgName of runtimePackages) {
    // Use rg --files to enumerate test files for this package
    const patterns = ['*test.ts', '*test.tsx', '*test.mjs', '*test.mts']
    const rgArgs = ['--files', `packages/${pkgName}/src`]
    for (const p of patterns) rgArgs.push('-g', p)

    let files = []
    try {
      const out = execFileSync('rg', rgArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (out.length > 0) files = out.split('\n').map((f) => f.trim()).filter(Boolean)
    } catch (err) {
      if (!(err && typeof err === 'object' && 'status' in err && err.status === 1)) throw err
    }

    for (const relPath of files) {
      const tier = classifyTestCapability(relPath)
      // relPath is already repo-relative (e.g. packages/foo/src/__tests__/bar.test.ts)
      tiers[tier].push(relPath)
    }
  }

  return tiers
}

function printCapabilityReport(repoRoot = process.cwd()) {
  const tiers = buildCapabilityReport(repoRoot)
  const tierOrder = ['unit', 'component', 'integration-external', 'e2e']

  console.log('\nCapability-tier inventory (MC-8 / TEST-M-03):')
  for (const tier of tierOrder) {
    const files = tiers[tier]
    console.log(`\n  ${tier} (${files.length} file${files.length === 1 ? '' : 's'}):`)
    if (files.length === 0) {
      console.log('    (none)')
    } else {
      for (const f of files) {
        console.log(`    - ${f}`)
      }
    }
  }

  const total = tierOrder.reduce((sum, t) => sum + tiers[t].length, 0)
  console.log(`\nTotal classified: ${total} test file${total === 1 ? '' : 's'}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--capability-report')) {
      printCapabilityReport()
    } else {
      const report = runRuntimeTestInventory()
      printRuntimeTestInventory(report)
      if (report.exitCode !== 0) {
        process.exitCode = report.exitCode
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
