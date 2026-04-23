import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')

const runtimePackageDenylist = new Set([
  'create-dzupagent',
  'playground',
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

function rgCount(args) {
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

function countTestFiles(srcPath, patterns) {
  const args = ['--files', srcPath]
  for (const pattern of patterns) {
    args.push('-g', pattern)
  }
  return rgCount(args)
}

// Some runtime packages (for example `flow-ast`, `flow-compiler`) keep their
// suites in a top-level `test/` directory rather than `src/__tests__/`. We
// scan both locations and sum the results so the inventory gate reflects the
// real suite coverage regardless of layout.
function countPackageTestFiles(packageName, patterns) {
  const srcPath = `packages/${packageName}/src`
  let total = countTestFiles(srcPath, patterns)

  const siblingTestDir = join(packagesDir, packageName, 'test')
  if (existsSync(siblingTestDir)) {
    total += countTestFiles(`packages/${packageName}/test`, patterns)
  }

  return total
}

const packageNames = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const runtimePackages = packageNames.filter((name) => {
  if (runtimePackageDenylist.has(name)) return false
  return existsSync(join(packagesDir, name, 'src'))
})

const summary = runtimePackages.map((name) => {
  const testCount = countPackageTestFiles(name, ['*test.ts', '*test.tsx'])
  const integrationStyleTestCount = countPackageTestFiles(name, integrationStyleTestPatterns)
  return {
    name,
    testCount,
    integrationStyleTestCount,
    critical: runtimeCriticalPackages.has(name),
  }
})

const failing = summary.filter((entry) => entry.testCount === 0)

console.log('Runtime package test inventory:')
for (const entry of summary) {
  console.log(
    `- ${entry.name}: ${entry.testCount} test file${entry.testCount === 1 ? '' : 's'}, ` +
      `${entry.integrationStyleTestCount} integration-style test${entry.integrationStyleTestCount === 1 ? '' : 's'}`,
  )
}

if (failing.length > 0) {
  console.error('\nZero-test runtime packages detected:')
  for (const entry of failing) {
    console.error(`- ${entry.name}`)
  }
  process.exit(1)
}

console.log('\nZero-test runtime package gate passed.')

if (strictIntegrationGateEnabled) {
  const integrationFailing = summary.filter((entry) => entry.critical && entry.integrationStyleTestCount === 0)

  if (integrationFailing.length > 0) {
    console.error('\nRuntime-critical packages without integration-style tests:')
    for (const entry of integrationFailing) {
      console.error(`- ${entry.name}`)
    }
    process.exit(1)
  }

  console.log('Strict integration-style runtime package gate passed.')
}
