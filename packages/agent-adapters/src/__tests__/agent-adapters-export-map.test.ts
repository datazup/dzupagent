import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  admitAdapterExecutionControls as providerAdmitAdapterExecutionControls,
  assertAdapterExecutionControlsAdmitted as providerAssertAdapterExecutionControlsAdmitted,
  buildExecutionControlAdmission as providerBuildExecutionControlAdmission,
  canonicalExecutionControlRequirement as providerCanonicalExecutionControlRequirement,
  executionControlRequirementSha256 as providerExecutionControlRequirementSha256,
  PiAdapter,
  OpenCodeAdapter,
  ClineAdapter,
  createCrushCliAdapter,
} from '../providers.js'

const execFileAsync = promisify(execFile)

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
        `${PACKAGING_ENV_VAR} is set but ${file} is missing; run build:verify for @dzupagent/agent-adapters first`,
      )
    })
  }
}

describe('agent-adapters export map', () => {
  it('exports optional SDK adapters through the existing providers subpath', () => {
    expect([PiAdapter, OpenCodeAdapter, ClineAdapter, createCrushCliAdapter].every(value => typeof value === 'function')).toBe(true)
  })

  it('keeps host SDKs as exact optional peers without raising the framework Node floor', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional: boolean }>
      optionalDependencies: Record<string, string>
      dependencies: Record<string, string>
    }
    const peers = { '@earendil-works/pi-coding-agent': '1.5.0', '@opencode-ai/sdk': '1.19.5', '@cline/sdk': '0.2.0', '@cline/shared': '0.2.0' }
    for (const [name, version] of Object.entries(peers)) {
      expect(manifest.peerDependencies[name]).toBe(version)
      expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true })
      expect(manifest.optionalDependencies).not.toHaveProperty(name)
      expect(manifest.dependencies).not.toHaveProperty(name)
    }
    const root = JSON.parse(await readFile(join(process.cwd(), '../../package.json'), 'utf8')) as { engines: { node: string } }
    expect(root.engines.node).toBe('>=20.0.0')
  })

  it.skipIf(!packagingEnabled)('runs the packed default Cline worker through ready, cancel and confirmed teardown without SDK loading', async () => {
    await requireDist('dist/providers.js', 'dist/providers.d.ts', 'dist/cline-worker.js', 'dist/cline/cline-adapter.d.ts')
    if (process.platform === 'win32' || Number(process.versions.node.split('.')[0]) < 22) {
      throw new Error('Packed Cline lifecycle qualification requires a POSIX Node >=22 host; the framework remains Node >=20')
    }
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-adapters-packed-worker-'))
    const env = { PATH: process.env['PATH'], HOME: tempDir, TMPDIR: tempDir,
      npm_config_cache: join(tempDir, '.npm-cache'), npm_config_offline: 'true', npm_config_ignore_scripts: 'true' }
    try {
      const { stdout } = await execFileAsync('npm', ['pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', tempDir], { cwd: process.cwd(), env })
      const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>
      if (!packed) throw new Error('npm pack returned no package')
      for (const path of ['dist/providers.js', 'dist/providers.d.ts', 'dist/cline-worker.js', 'dist/cline/cline-adapter.d.ts']) {
        expect(packed.files.some(file => file.path === path), `packed artifact must include ${path}`).toBe(true)
      }
      // This test deliberately fails a symlink-only or incomplete package instead of skipping.
      await execFileAsync('tar', ['-xzf', join(tempDir, packed.filename), '-C', tempDir], { env })
      const packageRoot = join(tempDir, 'package')
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>; peerDependencies: Record<string, string>
        peerDependenciesMeta: Record<string, { optional?: boolean }>
      }
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
        if (manifest.peerDependenciesMeta[name]?.optional) continue
        await mkdir(join(packageRoot, 'node_modules', name, '..'), { recursive: true })
        await symlink(join(process.cwd(), '../../node_modules', name), join(packageRoot, 'node_modules', name), 'dir')
      }
      // A no-code, unexported peer makes SDK resolution fail closed even if an
      // ancestor happens to have an installed Cline SDK. No installation occurs.
      await mkdir(join(packageRoot, 'node_modules/@cline/sdk'), { recursive: true })
      await writeFile(join(packageRoot, 'node_modules/@cline/sdk/package.json'), '{"name":"@cline/sdk","version":"0.0.0-fixture","exports":{}}\n')
      const consumer = join(tempDir, 'consumer')
      await mkdir(join(consumer, 'node_modules/@dzupagent'), { recursive: true })
      await symlink(packageRoot, join(consumer, 'node_modules/@dzupagent/agent-adapters'), 'dir')
      await symlink(join(process.cwd(), '../../node_modules/@types'), join(consumer, 'node_modules/@types'), 'dir')
      await mkdir(join(consumer, 'empty-profile'))
      await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n')
      // Reject and record even a caught attempt to load an optional SDK during import.
      const attempts = join(tempDir, 'sdk-load-attempts')
      await writeFile(attempts, '')
      await writeFile(join(consumer, 'deny-sdks.mjs'), [
        "import { appendFileSync } from 'node:fs'",
        `const attempts = ${JSON.stringify(attempts)}`,
        `const names = ${JSON.stringify(['@earendil-works/pi-coding-agent', '@opencode-ai/sdk', '@cline/sdk', '@cline/shared', '@cline/core', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@openai/codex-sdk', '@google/generative-ai', '@modelcontextprotocol/sdk'])}`,
        'export async function resolve(specifier, context, next) {',
        "  if (names.some(name => specifier === name || specifier.startsWith(name + '/'))) { appendFileSync(attempts, specifier + '\\n'); throw new Error('OPTIONAL_SDK_LOAD_FORBIDDEN') }",
        '  return next(specifier, context)',
        '}',
      ].join('\n'))
      await writeFile(join(consumer, 'worker-proof.mjs'), [
        "import assert from 'node:assert/strict'",
        "import childProcess from 'node:child_process'",
        "import { access, readFile } from 'node:fs/promises'",
        "import { register, syncBuiltinESMExports } from 'node:module'",
        "import { join } from 'node:path'",
        "register(new URL('./deny-sdks.mjs', import.meta.url))",
        'const spawned = []',
        'const nativeSpawn = childProcess.spawn',
        '// Observe the real transport, retaining the exact executable, args and options.',
        'childProcess.spawn = (...args) => {',
        '  const child = nativeSpawn(...args)',
        '  const observation = { child, args, messages: [], sent: [], closed: false }',
        '  spawned.push(observation)',
        "  child.on('message', value => observation.messages.push(value))",
        "  child.on('close', () => { observation.closed = true })",
        '  const send = child.send.bind(child)',
        '  child.send = (message, ...rest) => { observation.sent.push(message); return send(message, ...rest) }',
        '  return child',
        '}',
        'syncBuiltinESMExports()',
        "const providers = await import('@dzupagent/agent-adapters/providers')",
        "for (const name of ['PiAdapter', 'OpenCodeAdapter', 'ClineAdapter', 'createCrushCliAdapter']) assert.equal(typeof providers[name], 'function')",
        `assert.equal(await readFile(${JSON.stringify(attempts)}, 'utf8'), '')`,
        '// An empty fixture profile and a no-code unexported SDK prevent provider/auth effects.',
        "const profileDir = join(process.cwd(), 'empty-profile')",
        "const adapter = new providers.ClineAdapter({ profileDir, workingDirectory: process.cwd(), provider: 'fixture', model: 'fixture', timeoutMs: 5000 })",
        "const stream = adapter.execute({ prompt: 'provider-free cancellation', correlationId: 'packed-worker' })",
        'try {',
        '  const first = await stream.next()',
        "  assert.equal(first.value?.type, 'adapter:started')",
        '  assert.equal(spawned.length, 1)',
        '  const observed = spawned[0]',
        "  assert.equal(observed.messages[0]?.type, 'ready')",
        "  assert.equal(observed.args[1][0], new URL('../package/dist/cline-worker.js', import.meta.url).pathname)",
        '  assert.equal(observed.args[2].detached, true)',
        '  adapter.interrupt()',
        '  const rest = []; for await (const event of stream) rest.push(event)',
        "  const terminals = rest.filter(event => event.type === 'adapter:failed' || event.type === 'adapter:completed')",
        '  assert.equal(terminals.length, 1)',
        "  assert.equal(terminals[0].code, 'CLINE_CANCELLED')",
        "  assert.equal(terminals[0].correlationId, 'packed-worker')",
        "  assert.ok(observed.sent.some(message => message.type === 'cancel'))",
        '  assert.equal(observed.closed, true)',
        '  assert.equal(observed.child.connected, false)',
        '  assert.throws(() => process.kill(observed.child.pid, 0), { code: "ESRCH" })',
        '  assert.throws(() => process.kill(-observed.child.pid, 0), { code: "ESRCH" })',
        '  await assert.rejects(access(observed.args[2].cwd), { code: "ENOENT" })',
        '  const absentSdkEvents = []',
        "  for await (const event of adapter.execute({ prompt: 'absent SDK' })) absentSdkEvents.push(event)",
        "  assert.deepEqual(absentSdkEvents.map(event => event.type), ['adapter:started', 'adapter:failed'])",
        "  assert.equal(absentSdkEvents[1].code, 'CLINE_SDK_UNAVAILABLE')",
        '  assert.equal(spawned.length, 2)',
        '  assert.equal(spawned[1].closed, true)',
        '  assert.throws(() => process.kill(spawned[1].child.pid, 0), { code: "ESRCH" })',
        '  await assert.rejects(access(spawned[1].args[2].cwd), { code: "ENOENT" })',
        `  assert.equal(await readFile(${JSON.stringify(attempts)}, 'utf8'), '')`,
        "  process.stdout.write('packed-default-worker: ready/cancel/closed/home-removed\\n')",
        '} finally {',
        '  adapter.interrupt(); await stream.return()',
        '  childProcess.spawn = nativeSpawn; syncBuiltinESMExports()',
        '}',
      ].join('\n'))
      const proof = await execFileAsync(process.execPath, [join(consumer, 'worker-proof.mjs')], { cwd: consumer, env, timeout: 15_000 })
      expect(proof.stdout).toContain('packed-default-worker: ready/cancel/closed/home-removed')

      // Resolve the real packed export map and every newly public config/dependency type.
      const fixture = join(consumer, 'consumer.ts')
      await writeFile(fixture, [
        "import { PiAdapter, OpenCodeAdapter, ClineAdapter, createCrushCliAdapter } from '@dzupagent/agent-adapters/providers'",
        "import type { AdapterConfig, PiSdkLoader, OpenCodeAdapterConfig, OpenCodeAdapterDependencies, ClineAdapterConfig, ClineTransportFactory, CrushCliAdapterConfig } from '@dzupagent/agent-adapters/providers'",
        'export const pi = (config: AdapterConfig, loader?: PiSdkLoader) => new PiAdapter(config, loader)',
        'export const opencode = (config: OpenCodeAdapterConfig, deps: OpenCodeAdapterDependencies) => new OpenCodeAdapter(config, deps)',
        'export const cline = (config: ClineAdapterConfig, transport?: ClineTransportFactory) => new ClineAdapter(config, transport)',
        'export const crush = (config: CrushCliAdapterConfig) => createCrushCliAdapter(config)',
      ].join('\n'))
      await execFileAsync(process.execPath, [join(process.cwd(), '../../node_modules/typescript/bin/tsc'),
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture],
      { cwd: consumer, env, timeout: 30_000 })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 90_000)

  // Root barrel is growth-frozen (barrel-budgets rootDebtPin); execution-control
  // admission lands subpath-only via ./providers.
  it('exposes execution-control admission from the providers entrypoint', () => {
    const providers = [
      providerAdmitAdapterExecutionControls,
      providerAssertAdapterExecutionControlsAdmitted,
      providerBuildExecutionControlAdmission,
      providerCanonicalExecutionControlRequirement,
      providerExecutionControlRequirementSha256,
    ]

    expect(providers.every((value) => typeof value === 'function')).toBe(true)
  })

  it('exposes narrow runs and integration subpaths', async () => {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8')
    const packageJson = JSON.parse(raw) as { exports: Record<string, unknown> }

    expect(packageJson.exports['./runs']).toEqual({
      import: './dist/runs/index.js',
      types: './dist/runs/index.d.ts',
    })
    expect(packageJson.exports['./integration']).toEqual({
      import: './dist/integration/index.js',
      types: './dist/integration/index.d.ts',
    })
    expect(packageJson.exports['./pipeline']).toEqual({
      import: './dist/pipeline/index.js',
      types: './dist/pipeline/index.d.ts',
    })
    expect(packageJson.exports['./dzupagent']).toEqual({
      import: './dist/dzupagent/index.js',
      types: './dist/dzupagent/index.d.ts',
    })
    expect(packageJson.exports['./hard-budget']).toEqual({
      import: './dist/hard-budget.js',
      types: './dist/hard-budget.d.ts',
    })
    expect(packageJson.exports['./introspection']).toEqual({
      import: './dist/introspection/index.js',
      types: './dist/introspection/index.d.ts',
    })
    expect(packageJson.exports['./observability/dashboard']).toEqual({
      import: './dist/observability/dashboard.js',
      types: './dist/observability/dashboard.d.ts',
    })
    expect(packageJson.exports['./codex-goal-control']).toEqual({
      import: './dist/codex-goal-control.js',
      types: './dist/codex-goal-control.d.ts',
    })
  })

  it.skipIf(!packagingEnabled)('keeps Codex goal control and capability observation on the narrow built subpath', async () => {
    await requireDist('dist/codex-goal-control.js')

    const mod = await import('@dzupagent/agent-adapters/codex-goal-control')
    expect(mod).toEqual(expect.objectContaining({
      CodexAppServerAdapter: expect.any(Function),
      createCodexAppServerAdapter: expect.any(Function),
      createCodexGoalControlAdapter: expect.any(Function),
      materializeCodexAppServerCapabilityDescriptor: expect.any(Function),
      materializeCodexGoalCapabilityDescriptor: expect.any(Function),
      observeInstalledCodexAppServerCapability: expect.any(Function),
      observeInstalledCodexGoalCapability: expect.any(Function),
    }))
  })

  it.skipIf(!packagingEnabled)('resolves monitoring ESM and declarations through built package exports', async () => {
    await requireDist('dist/introspection/index.js', 'dist/observability/dashboard.js')

    await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await Promise.all([import('@dzupagent/agent-adapters/introspection'), import('@dzupagent/agent-adapters/observability/dashboard')])",
    ], { cwd: process.cwd() })

    const fixtureDir = await mkdtemp(join(tmpdir(), 'agent-adapters-types-resolution-'))
    try {
      // Keep generated consumers outside the checkout while resolving the real workspace package exports.
      await writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n', 'utf8')
      await symlink(join(process.cwd(), '../../node_modules'), join(fixtureDir, 'node_modules'), 'dir')
      const fixture = join(fixtureDir, 'consumer.ts')
      await writeFile(fixture, [
        "import { AdapterInstallationInspector, createNodeProbeRunner, resolveNodeProbeExecutable } from '@dzupagent/agent-adapters/introspection'",
        "import type { InspectorContext } from '@dzupagent/agent-adapters/introspection'",
        "import { DashboardProjectionSubscriber } from '@dzupagent/agent-adapters/observability/dashboard'",
        'const inspector: typeof AdapterInstallationInspector = AdapterInstallationInspector',
        'const subscriber: typeof DashboardProjectionSubscriber = DashboardProjectionSubscriber',
        "const safeRunner = createNodeProbeRunner({ executables: [], managedHome: '/tmp', cwd: '/tmp' })",
        "const accepted: InspectorContext = { runProbe: safeRunner, managedHome: '/tmp', now: () => '' }",
        "const arbitrary = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false })",
        '// @ts-expect-error arbitrary callbacks cannot bypass mandatory probe policy',
        'const rejected: InspectorContext = { ...accepted, runProbe: arbitrary }',
        'void inspector',
        'void subscriber',
        'void resolveNodeProbeExecutable',
        'void rejected',
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

  it.skipIf(!packagingEnabled)('passes a built Q4 V1 projection unchanged through the built V2 compatibility seam', async () => {
    await requireDist('dist/observability/dashboard.js', '../adapter-types/dist/monitoring/dashboard.js')

    const [projectionRuntime, dashboardRuntime, rootDashboardRuntime, coreRuntime] =
      await Promise.all([
        import('@dzupagent/agent-adapters/observability/dashboard'),
        import('@dzupagent/adapter-types/monitoring/dashboard'),
        import('@dzupagent/adapter-types'),
        import('@dzupagent/core'),
      ])
    const bus = coreRuntime.createEventBus()
    const subscriber = projectionRuntime.createDashboardProjectionSubscriber(bus, {
      runEventSource: {
        getProviderIds: () => ['claude'],
        getMetrics: (providerId: string) => ({
          providerId,
          rawEventCount: { value: 4, stale: false },
          normalizedEventCount: { value: 3, stale: false },
          artifactCount: { value: 1, stale: false },
          mcpToolUsageCount: { value: 0, stale: false },
          mcpMode: { value: 'native' as const, stale: false },
        }),
      },
      watcherSource: {
        getProviderIds: () => ['claude'],
        getMetrics: (providerId: string) => ({
          providerId,
          watcherState: { value: 'active' as const, stale: false },
        }),
      },
    })

    try {
      bus.emit({ type: 'agent:started', agentId: 'claude', runId: 'q4-v1-run' })
      bus.emit({
        type: 'tool:called',
        toolName: 'read',
        executionRunId: 'q4-v1-run',
      })
      bus.emit({
        type: 'agent:completed',
        agentId: 'claude',
        runId: 'q4-v1-run',
        durationMs: 5,
        usage: { inputTokens: 6, outputTokens: 2, costCents: 1 },
      })

      const q4V1 = subscriber.getProjection('claude')
      expect(q4V1).toEqual({
        providerId: 'claude',
        monitorTier: 'deep',
        watcherState: 'active',
        rawEventCount: 4,
        normalizedEventCount: 3,
        artifactCount: 1,
        toolCallCount: 1,
        approvalPromptCount: 0,
        mcpToolUsageCount: 0,
        mcpMode: 'native',
        costMicros: 10_000,
        totalTokens: 8,
        retryCount: 0,
        fallbackCount: null,
        successRate: 1,
      })

      const v2 = {
        v1: q4V1!,
        installationId: 'installation-1',
        installedVersion: '1.2.3',
        manifestHash: 'sha256:q4-manifest',
        healthOverall: 'healthy' as const,
        highestRungPassed: 4,
        lastCanaryAt: null,
        lastCanaryOutcome: null,
        lifecycleState: 'active' as const,
        driftFindingsOpen: 0,
        stalenessSeconds: 2,
        budget: { l5RemainingMicros: 100, l6RemainingMicros: null },
      }

      expect(dashboardRuntime.projectAdapterMonitorDashboardV1(v2)).toBe(q4V1)
      expect(dashboardRuntime.matchesAdapterMonitorDashboardV1Projection(v2, q4V1!)).toBe(true)
      expect(
        dashboardRuntime.matchesAdapterMonitorDashboardV1Projection(
          {
            ...v2,
            healthOverall: 'degraded',
            highestRungPassed: 2,
            stalenessSeconds: 30,
            budget: { l5RemainingMicros: 0, l6RemainingMicros: 0 },
          },
          q4V1!,
        ),
      ).toBe(true)
      expect(
        dashboardRuntime.matchesAdapterMonitorDashboardV1Projection(
          { ...v2, v1: { ...q4V1!, totalTokens: 9 } },
          q4V1!,
        ),
      ).toBe(false)

      expect(rootDashboardRuntime).not.toHaveProperty('projectAdapterMonitorDashboardV1')
      expect(rootDashboardRuntime).not.toHaveProperty(
        'matchesAdapterMonitorDashboardV1Projection',
      )
    } finally {
      subscriber.dispose()
    }
  }, 30_000)

  it.skipIf(!packagingEnabled)('imports the pipeline package subpath from built artifacts from built output', async () => {
    await requireDist('dist/pipeline/index.js')

    const mod = await import(join(process.cwd(), 'dist/pipeline/index.js'))

    expect(mod).toEqual(expect.objectContaining({
      AdapterPipeline: expect.any(Function),
      createAdapterRuntimeToolHandlers: expect.any(Function),
    }))
  })

  it.skipIf(!packagingEnabled)('imports recently published subpaths from packed tarball output from built output', async (ctx) => {
    await requireDist('dist/index.js')

    const tempDir = await mkdtemp(join(tmpdir(), 'agent-adapters-pack-'))
    try {
      const { stdout } = await execFileAsync('npm', [
        'pack',
        '--json',
        '--pack-destination',
        tempDir,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          npm_config_cache: join(tempDir, '.npm-cache'),
        },
      })
      const [packed] = JSON.parse(stdout) as Array<{ filename: string, files: Array<{ path: string }> }>
      if (!packed) {
        throw new Error(`npm pack --json returned no entries: ${stdout}`)
      }
      const { filename } = packed
      await execFileAsync('tar', ['-xzf', join(tempDir, filename), '-C', tempDir])

      const packageRoot = join(tempDir, 'package')
      // npm pack does not follow a symlinked dist (a Storage worktree links the canonical build),
      // so only that layout may skip; a real dist directory missing from the pack is a packaging
      // regression. A pack that carries dist must still carry every subpath below.
      const packedDist = await access(join(packageRoot, 'dist/index.js')).then(() => true, () => false)
      if (!packedDist) {
        if (packed.files.some(({ path }) => path === 'dist' || path.startsWith('dist/'))) {
          throw new Error('packed tarball contains a partial dist without dist/index.js')
        }
        const distIsSymlink = await lstat(join(process.cwd(), 'dist')).then((info) => info.isSymbolicLink(), () => false)
        if (!distIsSymlink) throw new Error('packed tarball carries no dist/index.js although dist is a local directory')
        ctx.skip('packed tarball carries no dist/index.js because dist is a symlink, which npm pack does not follow')
      }
      const imports = await Promise.all([
        import(pathToFileURL(join(packageRoot, 'dist/pipeline/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/runs/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/skills.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/enrichment.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/fleet-executors/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/subagents/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/hard-budget.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/introspection/index.js')).href),
        import(pathToFileURL(join(packageRoot, 'dist/observability/dashboard.js')).href),
      ])

      expect(imports[0]).toEqual(expect.objectContaining({
        AdapterPipeline: expect.any(Function),
        createAdapterRuntimeToolHandlers: expect.any(Function),
      }))
      expect(imports[1]).toEqual(expect.objectContaining({
        RunEventStore: expect.any(Function),
        ScriptRunEventStore: expect.any(Function),
      }))
      expect(imports[2]).toEqual(expect.objectContaining({
        AdapterSkillRegistry: expect.any(Function),
        createDefaultSkillRegistry: expect.any(Function),
      }))
      expect(imports[3]).toEqual(expect.objectContaining({
        EnrichmentPipeline: expect.any(Function),
      }))
      expect(imports[4]).toEqual(expect.objectContaining({
        AdapterFleetExecutor: expect.any(Function),
        mapWorkerSpecToAgentExecution: expect.any(Function),
      }))
      expect(imports[5]).toEqual(expect.objectContaining({
        RegistrySubagentExecutor: expect.any(Function),
        createWiredSubagentRuntime: expect.any(Function),
      }))
      expect(imports[6]).toEqual(expect.objectContaining({
        AdapterHardBudgetHostProfileRegistry: expect.any(Function),
        prepareAdapterHardBudgetInput: expect.any(Function),
        prepareAdapterHardBudgetInputWithProof: expect.any(Function),
        createOpenAIResponsesInputTokenProofBinding: expect.any(Function),
        OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT:
          expect.stringMatching(/^[a-f0-9]{64}$/),
      }))
      expect(imports[7]).toEqual(expect.objectContaining({
        AdapterInstallationInspector: expect.any(Function),
        buildCapabilityManifest: expect.any(Function),
        ObservedCapabilitiesLiveSubscriber: expect.any(Function),
        reduceRunEventsToObservedCapabilities: expect.any(Function),
        replayObservedCapabilities: expect.any(Function),
      }))
      expect(imports[7]).not.toHaveProperty('createInternalSafeProbeRunner')
      expect(imports[7]).not.toHaveProperty('createNodeProbeRunnerForTesting')
      expect(imports[8]).toEqual(expect.objectContaining({
        DashboardProjectionSubscriber: expect.any(Function),
        createDashboardProjectionSubscriber: expect.any(Function),
      }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 90_000)
})
