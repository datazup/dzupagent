import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const monitoringExports = {
  './monitoring/installation': 'installation',
  './monitoring/health': 'health',
  './monitoring/lifecycle': 'lifecycle',
  './monitoring/posture': 'posture',
  './monitoring/dashboard': 'dashboard',
} as const

/**
 * Packaging checks need this package's own built `dist`, which the default
 * test task does not build. Without the packaging flag they are reported as
 * skipped, never as passed; with it (see `test:packaging`) a missing `dist`
 * fails the spec instead of returning early.
 */
const PACKAGING_ENV_VAR = 'DZUPAGENT_PACKAGING_TESTS'
const packagingEnabled = (process.env[PACKAGING_ENV_VAR] ?? '').length > 0

async function requireDist(...files: string[]): Promise<void> {
  for (const file of files) {
    await access(join(process.cwd(), file)).catch(() => {
      throw new Error(
        `${PACKAGING_ENV_VAR} is set but ${file} is missing; run build:verify for @dzupagent/adapter-types first`,
      )
    })
  }
}

describe('adapter-types monitoring export map', () => {
  it('publishes one narrow export per monitoring plane', async () => {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8')
    const packageJson = JSON.parse(raw) as { exports: Record<string, unknown> }

    for (const [exportPath, artifact] of Object.entries(monitoringExports)) {
      expect(packageJson.exports[exportPath]).toEqual({
        import: `./dist/monitoring/${artifact}.js`,
        types: `./dist/monitoring/${artifact}.d.ts`,
      })
    }
  })

  it('documents every monitoring subpath for consumers', async () => {
    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')

    for (const exportPath of Object.keys(monitoringExports)) {
      expect(readme).toContain(`@dzupagent/adapter-types${exportPath.slice(1)}`)
    }
  })

  it.skipIf(!packagingEnabled)('resolves ESM and declarations through built package exports from built output', async () => {
    await requireDist('dist/monitoring/dashboard.js')

    const specifiers = Object.keys(monitoringExports).map(
      (exportPath) => `@dzupagent/adapter-types${exportPath.slice(1)}`,
    )
    await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)))`,
    ], { cwd: process.cwd() })

    const fixtureDir = await mkdtemp(join(process.cwd(), '.types-resolution-'))
    try {
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import type { AdapterInstallationRef } from '@dzupagent/adapter-types/monitoring/installation'",
        "import type { AdapterHealthReport } from '@dzupagent/adapter-types/monitoring/health'",
        "import type { AdapterLifecyclePlan } from '@dzupagent/adapter-types/monitoring/lifecycle'",
        "import type { AdapterSecurityPosture } from '@dzupagent/adapter-types/monitoring/posture'",
        "import { matchesAdapterMonitorDashboardV1Projection, type AdapterMonitorDashboardContract, type AdapterMonitorDashboardContractV2 } from '@dzupagent/adapter-types/monitoring/dashboard'",
        '// @ts-expect-error V2 monitoring contracts are intentionally subpath-only',
        "import type { AdapterMonitorDashboardContractV2 as RootDashboardV2 } from '@dzupagent/adapter-types'",
        'type Resolved = AdapterInstallationRef | AdapterHealthReport | AdapterLifecyclePlan | AdapterSecurityPosture | AdapterMonitorDashboardContract | AdapterMonitorDashboardContractV2',
        'const matcher: typeof matchesAdapterMonitorDashboardV1Projection = matchesAdapterMonitorDashboardV1Projection',
        'void (null as Resolved | null)',
        'void (null as RootDashboardV2 | null)',
        'void matcher',
      ].join('\n'), 'utf8')

      await execFileAsync(process.execPath, [
        join(process.cwd(), '../../node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        fixture,
      ], { cwd: process.cwd() })
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  }, 30_000)

  it.skipIf(!packagingEnabled)('keeps V2 runtime helpers off the compatibility root barrel', async () => {
    await requireDist('dist/index.js')

    const rootRuntime = await import('@dzupagent/adapter-types')
    expect(rootRuntime).not.toHaveProperty('projectAdapterMonitorDashboardV1')
    expect(rootRuntime).not.toHaveProperty('matchesAdapterMonitorDashboardV1Projection')
  })
})
