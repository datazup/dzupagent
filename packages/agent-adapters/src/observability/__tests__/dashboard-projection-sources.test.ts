import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArtifactWatcherHost } from '../../base/artifact-watcher-host.js'
import { MCPToolSharingBridge } from '../../mcp/mcp-tool-sharing.js'
import { CostTrackingMiddleware } from '../../middleware/cost-tracking.js'
import { EventBusBridge } from '../../registry/event-bus-bridge.js'
import { ProviderAdapterRegistry } from '../../registry/adapter-registry.js'
import { RunEventStore } from '../../runs/run-event-store.js'
import {
  createDashboardProjectionSubscriber,
} from '../dashboard-projection-subscriber.js'
import {
  createArtifactWatcherHostDashboardSource,
  createCostTrackingDashboardSource,
  createGovernanceDashboardSource,
  createMcpToolSharingDashboardSource,
  createRouterFallbackDashboardSource,
  createRunEventStoreDashboardSource,
} from '../dashboard-projection-sources.js'
import type { DashboardProjectionSource } from '../dashboard-projection-subscriber.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskRoutingStrategy,
} from '../../types.js'

const explicitWatcherEvidence: DashboardProjectionSource = {
  getMetrics: (providerId) => ({
    providerId,
    watcherState: { value: 'not_configured', stale: false },
  }),
}

describe('framework-owned dashboard sources', () => {
  it('preserves a stale ArtifactWatcherHost observation instead of fabricating not_configured', () => {
    const bus = createEventBus()
    const host = new ArtifactWatcherHost('claude')
    host.setFactory(() => ({ stop() {} }))
    host.start(['/tmp/watched'])
    const source = createArtifactWatcherHostDashboardSource(host, {
      now: () => host.getStatusObservedAt() + 10,
      staleAfterMs: 1,
    })
    const subscriber = createDashboardProjectionSubscriber(bus, { watcherSource: source })

    expect(subscriber.getProjection('claude')!.watcherState).toBe('active')
    subscriber.dispose()
  })

  it('projects MCP mode and invocations from the provider-bound Codex host handler', async () => {
    const bus = createEventBus()
    const bridge = new MCPToolSharingBridge()
    bridge.registerTool({
      name: 'read',
      description: 'read a value',
      inputSchema: { type: 'object' },
      handler: async () => 'ok',
    })
    const config = bridge.buildAdapterToolConfig('codex') as {
      dynamicTools: Array<{ handler: (args: Record<string, unknown>) => Promise<string> }>
    }
    const subscriber = createDashboardProjectionSubscriber(bus, {
      mcpSource: createMcpToolSharingDashboardSource(bridge),
      watcherSource: explicitWatcherEvidence,
    })
    await config.dynamicTools[0]!.handler({})
    await config.dynamicTools[0]!.handler({})

    expect(subscriber.getProjection('codex')).toMatchObject({
      mcpMode: 'native',
      mcpToolUsageCount: 2,
    })
    subscriber.dispose()
  })

  it('projects native zero separately from unavailable system-prompt-fallback usage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bus = createEventBus()
      const bridge = new MCPToolSharingBridge()
      bridge.buildAdapterToolConfig('codex')
      bridge.buildAdapterToolConfig('gemini')
      const subscriber = createDashboardProjectionSubscriber(bus, {
        mcpSource: createMcpToolSharingDashboardSource(bridge),
        watcherSource: explicitWatcherEvidence,
      })

      expect(subscriber.getProjection('codex')).toMatchObject({
        mcpMode: 'native',
        mcpToolUsageCount: 0,
      })
      expect(subscriber.getProjection('gemini')).toMatchObject({
        mcpMode: 'system-prompt-fallback',
        mcpToolUsageCount: null,
      })
      subscriber.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('projects measured usage from CostTrackingMiddleware', async () => {
    const bus = createEventBus()
    const cost = new CostTrackingMiddleware({})
    async function* events() {
      yield {
        type: 'adapter:completed' as const,
        providerId: 'claude' as const,
        sessionId: 'session-1',
        result: 'ok',
        durationMs: 1,
        timestamp: 1,
        usage: { inputTokens: 4, outputTokens: 3, costCents: 2 },
      }
    }
    for await (const _event of cost.wrap(events())) void _event
    const subscriber = createDashboardProjectionSubscriber(bus, {
      costSource: createCostTrackingDashboardSource(cost),
      watcherSource: explicitWatcherEvidence,
    })

    expect(subscriber.getProjection('claude')).toMatchObject({
      costMicros: 20_000,
      totalTokens: 7,
    })
    subscriber.dispose()
  })

  it('projects router fallbacks from the real router through EventBusBridge agent:progress', async () => {
    const bus = createEventBus()
    const subscriber = createDashboardProjectionSubscriber(bus, {
      routerFallbackSource: createRouterFallbackDashboardSource(bus),
      watcherSource: explicitWatcherEvidence,
    })
    const eventsFor = (providerId: AdapterProviderId, succeeds: boolean): AgentEvent[] => [
      { type: 'adapter:started', providerId, sessionId: `${providerId}-session`, timestamp: 1 },
      succeeds
        ? { type: 'adapter:completed', providerId, sessionId: `${providerId}-session`, result: 'ok', durationMs: 1, timestamp: 2 }
        : { type: 'adapter:failed', providerId, error: 'failed', code: 'ADAPTER_EXECUTION_FAILED', timestamp: 2 },
    ]
    const adapter = (providerId: AdapterProviderId, succeeds: boolean): AgentCLIAdapter => ({
      providerId,
      async *execute(_input: AgentInput) {
        for (const event of eventsFor(providerId, succeeds)) yield event
      },
      async *resumeSession() { return },
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
      getCapabilities: () => ({
        supportsResume: false,
        supportsFork: false,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsCostUsage: false,
      }),
    })
    const fixed: TaskRoutingStrategy = {
      name: 'dashboard-real-router',
      route: (_task, available) => ({
        provider: available[0]!,
        fallbackProviders: available.slice(1),
        reason: 'test fallback path',
        confidence: 1,
      }),
    }
    const registry = new ProviderAdapterRegistry()
      .register(adapter('claude', false))
      .register(adapter('codex', true))
      .setRouter(fixed)
    const bridge = new EventBusBridge(bus)
    for await (const _event of bridge.bridge(registry.executeWithFallback(
      { prompt: 'p' },
      { prompt: 'p', tags: [], approvedFallbackProviders: ['claude', 'codex'] },
    ), 'router-run')) void _event

    expect(subscriber.getProjection('codex')).toMatchObject({ fallbackCount: 1 })
    subscriber.dispose()
  })

  it('deduplicates governance aliases from the event bus', () => {
    const bus = createEventBus()
    const subscriber = createDashboardProjectionSubscriber(bus, {
      governanceSource: createGovernanceDashboardSource(bus),
      watcherSource: explicitWatcherEvidence,
    })
    bus.emit({ type: 'agent:started', agentId: 'claude', runId: 'run-1' })
    bus.emit({
      type: 'adapter:interaction_required',
      interactionId: 'approval-1',
      providerId: 'claude',
      question: 'allow?',
      kind: 'permission',
    })
    bus.emit({
      type: 'governance:approval_requested',
      runId: 'run-1',
      approvalId: 'approval-1',
    })

    expect(subscriber.getProjection('claude')).toMatchObject({ approvalPromptCount: 1 })
    subscriber.dispose()
  })

  it('automatically recovers overflow, process death, and repeated records during immediate shutdown', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'dashboard-retained-'))
    try {
      const store = new RunEventStore({ runId: 'retained-run', projectDir })
      await store.open()
      await store.appendNormalized({
        type: 'adapter:started',
        providerId: 'codex',
        sessionId: 'session-1',
        timestamp: 1,
      })
      const toolCall = {
        type: 'adapter:tool_call' as const,
        providerId: 'codex' as const,
        toolName: 'read',
        toolCallId: 'tool-1',
        input: {},
        timestamp: 2,
      }
      await store.appendNormalized(toolCall)
      await store.appendNormalized(toolCall)
      await store.appendNormalized({
        type: 'adapter:failed',
        providerId: 'codex',
        sessionId: 'session-1',
        error: 'process died',
        timestamp: 3,
      })

      const bus = createEventBus()
      const subscriber = createDashboardProjectionSubscriber(bus, {
        maxQueuedEvents: 1,
        runEventStores: [store],
        runEventSource: createRunEventStoreDashboardSource('codex', store),
        watcherSource: explicitWatcherEvidence,
      })
      bus.emit({ type: 'agent:started', agentId: 'codex', runId: 'live-run' })
      bus.emit({ type: 'tool:called', toolName: 'read', executionRunId: 'live-run' })
      expect(subscriber.getStats().overflowedEvents).toBe(1)

      await subscriber.shutdown()
      expect(subscriber.getProjection('codex')).toMatchObject({
        toolCallCount: 2,
        normalizedEventCount: 4,
        successRate: 0,
      })
      expect(subscriber.getStats().openRuns).toBe(0)
      expect(subscriber.getStats().retainedRecoveries).toBe(1)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
