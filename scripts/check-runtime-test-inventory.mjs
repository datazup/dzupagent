import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

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
    const testCount = countPackageTestFiles(name, ['*test.ts', '*test.tsx'], context)
    const integrationStyleTestCount = countPackageTestFiles(name, integrationStyleTestPatterns, context)
    return {
      name,
      testCount,
      integrationStyleTestCount,
      critical: runtimeCriticalPackages.has(name),
    }
  })

  const zeroTestFailing = summary.filter((entry) => entry.testCount === 0)
  const criticalSourceCoverage = evaluateCriticalSourceCoverage(context)
  const criticalSourceFailing = criticalSourceCoverage.filter((entry) => entry.status === 'fail')
  const integrationFailing = strictIntegration
    ? summary.filter((entry) => entry.critical && entry.integrationStyleTestCount === 0)
    : []
  const exitCode = zeroTestFailing.length > 0 || criticalSourceFailing.length > 0 || integrationFailing.length > 0 ? 1 : 0

  return {
    summary,
    zeroTestFailing,
    criticalSourceCoverage,
    criticalSourceFailing,
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
        `${entry.integrationStyleTestCount} integration-style test${entry.integrationStyleTestCount === 1 ? '' : 's'}`,
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

  if (report.strictIntegration) {
    if (report.integrationFailing.length > 0) {
      console.error('\nRuntime-critical packages without integration-style tests:')
      for (const entry of report.integrationFailing) {
        console.error(`- ${entry.name}`)
      }
      return
    }

    console.log('Strict integration-style runtime package gate passed.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = runRuntimeTestInventory()
    printRuntimeTestInventory(report)
    if (report.exitCode !== 0) {
      process.exitCode = report.exitCode
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
