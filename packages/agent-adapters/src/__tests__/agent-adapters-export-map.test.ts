import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

describe('agent-adapters export map', () => {
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

  it('keeps Codex goal control and capability observation on the narrow built subpath', async () => {
    try {
      await access(join(process.cwd(), 'dist/codex-goal-control.js'))
    } catch {
      return
    }

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

  it('resolves monitoring ESM and declarations through built package exports', async () => {
    try {
      await access(join(process.cwd(), 'dist/introspection/index.js'))
      await access(join(process.cwd(), 'dist/observability/dashboard.js'))
    } catch {
      return
    }

    await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await Promise.all([import('@dzupagent/agent-adapters/introspection'), import('@dzupagent/agent-adapters/observability/dashboard')])",
    ], { cwd: process.cwd() })

    const fixtureDir = await mkdtemp(join(process.cwd(), '.types-resolution-'))
    try {
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

  it('passes a built Q4 V1 projection unchanged through the built V2 compatibility seam', async () => {
    try {
      await access(join(process.cwd(), 'dist/observability/dashboard.js'))
      await access(join(process.cwd(), '../adapter-types/dist/monitoring/dashboard.js'))
    } catch {
      return
    }

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

  it('imports the pipeline package subpath from built artifacts when dist exists', async () => {
    const builtPipeline = join(process.cwd(), 'dist/pipeline/index.js')
    try {
      await access(builtPipeline)
    } catch {
      return
    }

    const mod = await import(builtPipeline)

    expect(mod).toEqual(expect.objectContaining({
      AdapterPipeline: expect.any(Function),
      createAdapterRuntimeToolHandlers: expect.any(Function),
    }))
  })

  it('imports recently published subpaths from packed tarball output when dist exists', async () => {
    try {
      await access(join(process.cwd(), 'dist/index.js'))
    } catch {
      return
    }

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
      const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>
      await execFileAsync('tar', ['-xzf', join(tempDir, filename), '-C', tempDir])

      const packageRoot = join(tempDir, 'package')
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
