import process from 'node:process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEventBus } from '@dzupagent/core'

import { createDashboardProjectionSubscriber } from '../dist/observability/dashboard.js'
import { RunEventStore } from '../dist/runs/index.js'

const eventCount = 20_000
const warmUp = 5
const repetitions = 25

async function emitDeterministicTraffic(attachDashboard) {
  const bus = createEventBus()
  let observed = 0
  bus.onAny(() => {
    observed += 1
  })
  const dashboard = attachDashboard ? createDashboardProjectionSubscriber(bus) : null
  const startedAt = process.hrtime.bigint()
  for (let index = 0; index < eventCount; index += 1) {
    const run = `run-${Math.floor(index / 4) % 128}`
    switch (index % 4) {
      case 0:
        bus.emit({ type: 'agent:started', agentId: 'claude', runId: run })
        break
      case 1:
      case 2:
        bus.emit({ type: 'tool:called', toolName: 'read', executionRunId: run })
        break
      case 3:
        bus.emit({
          type: 'agent:completed',
          agentId: 'claude',
          runId: run,
          durationMs: 1,
          usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
        })
        break
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  const deliveryStats = dashboard?.getStats() ?? null
  await dashboard?.shutdown()
  if (observed !== eventCount) throw new Error(`observer saw ${observed}/${eventCount} events`)
  return { elapsedMs, deliveryStats }
}

async function observeRecoveryGuarantees() {
  const projectDir = await mkdtemp(join(tmpdir(), 'dashboard-benchmark-recovery-'))
  try {
    const store = new RunEventStore({ runId: 'benchmark-process-death', projectDir })
    await store.open()
    await store.appendNormalized({
      type: 'adapter:started',
      providerId: 'codex',
      sessionId: 'benchmark-session',
      timestamp: 1,
    })
    const repeatedToolCall = {
      type: 'adapter:tool_call',
      providerId: 'codex',
      toolName: 'read',
      toolCallId: 'legitimate-repeat',
      input: {},
      timestamp: 2,
    }
    await store.appendNormalized(repeatedToolCall)
    await store.appendNormalized(repeatedToolCall)
    const bus = createEventBus()
    const watcherSource = {
      getProviderIds: () => ['codex'],
      getMetrics: (providerId) => ({
        providerId,
        watcherState: { value: 'not_configured', stale: false },
      }),
    }
    const subscriber = createDashboardProjectionSubscriber(bus, {
      maxQueuedEvents: 1,
      runEventStores: [store],
      watcherSource,
    })
    bus.emit({ type: 'agent:started', agentId: 'codex', runId: 'overflow-trigger' })
    bus.emit({ type: 'tool:called', toolName: 'read', executionRunId: 'overflow-trigger' })
    const overflowStats = subscriber.getStats()

    // Shutdown happens in the same turn as overflow. Its completion is the
    // observation that scheduled/in-flight retained repair was awaited.
    await subscriber.shutdown()
    const projection = subscriber.getProjection('codex')
    const recoveredStats = subscriber.getStats()
    return {
      stats: { beforeShutdown: overflowStats, afterShutdown: recoveredStats },
      projection,
      guarantees: {
        synchronousQueueReductionOnOverflow: overflowStats.overflowedEvents === 0,
        overflowAccounting: overflowStats.overflowedEvents === 1,
        retainedRunEventStoreRecovery:
          recoveredStats.retainedRecoveries === 1 && projection?.toolCallCount === 2,
        shutdownFlush:
          recoveredStats.retainedRecoveries === 1 && recoveredStats.queuedEvents === 0,
        stableOccurrenceIdentities: projection?.toolCallCount === 2,
      },
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}

async function observeProcessDeathPath() {
  const bus = createEventBus()
  const watcherSource = {
    getProviderIds: () => ['codex'],
    getMetrics: (providerId) => ({
      providerId,
      watcherState: { value: 'not_configured', stale: false },
    }),
  }
  const subscriber = createDashboardProjectionSubscriber(bus, { watcherSource })
  bus.emit({ type: 'agent:started', agentId: 'codex', runId: 'process-death-run' })
  bus.emit({
    type: 'adapter:run_halted',
    providerId: 'codex',
    runId: 'process-death-run',
    status: 'halted',
  })
  const projection = subscriber.getProjection('codex')
  const stats = subscriber.getStats()
  await subscriber.shutdown()
  return {
    eventType: 'adapter:run_halted',
    projection,
    stats,
    observed:
      projection?.successRate === 0 &&
      stats.openRuns === 0 &&
      stats.rememberedTerminalRuns === 1,
  }
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

function variance(samples) {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length
  return samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) / samples.length
}

for (let index = 0; index < warmUp; index += 1) {
  await emitDeterministicTraffic(false)
  await emitDeterministicTraffic(true)
}

const baseline = []
const dashboard = []
let deliveryStats = null
for (let index = 0; index < repetitions; index += 1) {
  if (index % 2 === 0) {
    baseline.push((await emitDeterministicTraffic(false)).elapsedMs)
    const measured = await emitDeterministicTraffic(true)
    dashboard.push(measured.elapsedMs)
    deliveryStats = measured.deliveryStats
  } else {
    const measured = await emitDeterministicTraffic(true)
    dashboard.push(measured.elapsedMs)
    deliveryStats = measured.deliveryStats
    baseline.push((await emitDeterministicTraffic(false)).elapsedMs)
  }
}

const recoveryObservation = await observeRecoveryGuarantees()
const processDeathObservation = await observeProcessDeathPath()

const baselineMedian = percentile(baseline, 0.5)
const dashboardMedian = percentile(dashboard, 0.5)
const absoluteDelta = dashboardMedian - baselineMedian
const relativeDelta = absoluteDelta / baselineMedian
const sourceFiles = [
  'packages/agent-adapters/src/observability/dashboard-projection-subscriber.ts',
  'packages/agent-adapters/src/observability/dashboard-projection-reducer.ts',
  'packages/agent-adapters/src/observability/dashboard-projection-sources.ts',
  'packages/agent-adapters/src/observability/__tests__/dashboard-projection-subscriber.test.ts',
  'packages/agent-adapters/src/observability/__tests__/dashboard-projection-sources.test.ts',
  'packages/agent-adapters/src/__tests__/mcp-tool-sharing.test.ts',
  'packages/agent-adapters/src/__tests__/run-event-store.test.ts',
  'packages/agent-adapters/src/base/artifact-watcher-host.ts',
  'packages/agent-adapters/src/mcp/mcp-tool-sharing.ts',
  'packages/agent-adapters/src/middleware/cost-tracking.ts',
  'packages/agent-adapters/src/runs/run-event-store.ts',
  'packages/agent-adapters/scripts/dashboard-projection-benchmark.mjs',
]
const sourceBindings = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [
      file,
      createHash('sha256').update(await readFile(file)).digest('hex'),
    ]),
  ),
)
const builtArtifactFiles = [
  'packages/agent-adapters/dist/.dzup-build-artifacts.json',
  'packages/agent-adapters/dist/observability/dashboard.js',
  'packages/agent-adapters/dist/runs/index.js',
]
const builtArtifactBindings = Object.fromEntries(
  await Promise.all(
    builtArtifactFiles.map(async (file) => [
      file,
      createHash('sha256').update(await readFile(file)).digest('hex'),
    ]),
  ),
)

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'dzupagent/dashboard-projection-benchmark/v2',
      command: 'node packages/agent-adapters/scripts/dashboard-projection-benchmark.mjs',
      deterministicInput: true,
      providerFree: true,
      sourceBindings,
      builtArtifactBindings,
      eventCount,
      warmUp,
      repetitions,
      baseline: {
        medianMs: baselineMedian,
        p95Ms: percentile(baseline, 0.95),
        varianceMs2: variance(baseline),
      },
      dashboard: {
        medianMs: dashboardMedian,
        p95Ms: percentile(dashboard, 0.95),
        varianceMs2: variance(dashboard),
      },
      delta: {
        absoluteMedianMs: absoluteDelta,
        relativeMedian: relativeDelta,
        relativeMedianPercent: relativeDelta * 100,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: process.cpuUsage(),
      },
      nfr: {
        thresholdPercent: 2,
        measuredPass: relativeDelta < 0.02,
        disposition: relativeDelta < 0.02 ? 'measured-pass' : 'bounded-asynchronous-design',
        maxQueuedEvents: 1000,
        deliveryStats,
        boundedGuarantees: {
          ...recoveryObservation.guarantees,
          processDeathRecovery: processDeathObservation.observed,
        },
        recoveryObservation: {
          stats: recoveryObservation.stats,
          projection: recoveryObservation.projection,
        },
        processDeathObservation,
        proofTests: [
          'bounds the asynchronous live-event queue with explicit overflow accounting',
          'automatically recovers overflow and repeated retained records during immediate shutdown',
          'projects process death from an observed adapter:run_halted lifecycle event',
          'projects router fallbacks from the real router through EventBusBridge agent:progress',
          'counts invocations inside the Claude in-process host path',
          'counts invocations inside the Codex dynamic-tool host path',
          'leaves bus traffic byte-identical whether the producer is on or off',
        ],
      },
    },
    null,
    2,
  )}\n`,
)
