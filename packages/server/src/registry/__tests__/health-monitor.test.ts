import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HealthMonitor } from '../health-monitor.js'
import type { ProbeResult } from '../health-monitor.js'
import { InMemoryRegistry } from '@dzipagent/core'
import type { AgentRegistry, RegisterAgentInput, ForgeCapability } from '@dzipagent/core'

// --- Helpers ---

function makeCap(name: string): ForgeCapability {
  return { name, version: '1.0.0', description: `Cap: ${name}` }
}

function makeInput(overrides?: Partial<RegisterAgentInput>): RegisterAgentInput {
  return {
    name: 'test-agent',
    description: 'A test agent',
    capabilities: [makeCap('test.cap')],
    endpoint: 'http://localhost:3000/health',
    ...overrides,
  }
}

function createSuccessProbe(latencyMs = 50): (endpoint: string, timeoutMs: number) => Promise<ProbeResult> {
  return async (_endpoint: string, _timeoutMs: number) => ({
    success: true,
    latencyMs,
    statusCode: 200,
  })
}

function createFailureProbe(): (endpoint: string, timeoutMs: number) => Promise<ProbeResult> {
  return async (_endpoint: string, _timeoutMs: number) => ({
    success: false,
    latencyMs: 5000,
    error: 'Connection refused',
  })
}

// --- Tests ---

describe('HealthMonitor', () => {
  let registry: AgentRegistry
  let monitor: HealthMonitor

  beforeEach(() => {
    registry = new InMemoryRegistry()
  })

  afterEach(() => {
    monitor?.stop()
  })

  it('probes a healthy agent successfully', async () => {
    const agent = await registry.register(makeInput())
    monitor = new HealthMonitor({
      registry,
      probeFn: createSuccessProbe(42),
    })

    const health = await monitor.probeAgent(agent.id)

    expect(health.status).toBe('healthy')
    expect(health.lastCheckedAt).toBeInstanceOf(Date)
    expect(health.lastSuccessAt).toBeInstanceOf(Date)
    expect(health.consecutiveSuccesses).toBe(1)
    expect(health.consecutiveFailures).toBe(0)
    expect(health.circuitState).toBe('closed')
    expect(health.latencyP50Ms).toBe(42)
  })

  it('marks agent as unhealthy after consecutive failures', async () => {
    const agent = await registry.register(makeInput())
    monitor = new HealthMonitor({
      registry,
      probeFn: createFailureProbe(),
      failureThreshold: 3,
    })

    // Probe 3 times to trigger circuit open
    await monitor.probeAgent(agent.id)
    await monitor.probeAgent(agent.id)
    const health = await monitor.probeAgent(agent.id)

    expect(health.status).toBe('unhealthy')
    expect(health.consecutiveFailures).toBe(3)
    expect(health.circuitState).toBe('open')
  })

  it('transitions through circuit breaker states', async () => {
    const agent = await registry.register(makeInput())

    let shouldFail = true
    const dynamicProbe = async (_endpoint: string, _timeoutMs: number): Promise<ProbeResult> => {
      if (shouldFail) return { success: false, latencyMs: 100, error: 'fail' }
      return { success: true, latencyMs: 50 }
    }

    monitor = new HealthMonitor({
      registry,
      probeFn: dynamicProbe,
      failureThreshold: 2,
    })

    // Fail twice -> open
    await monitor.probeAgent(agent.id)
    await monitor.probeAgent(agent.id)
    expect(monitor.getCircuitState(agent.id)).toBe('open')

    // Next probe transitions to half-open, then success -> closed
    shouldFail = false
    const health = await monitor.probeAgent(agent.id)
    expect(health.status).toBe('healthy')
    expect(health.circuitState).toBe('closed')
  })

  it('tracks latency percentiles with sliding window', async () => {
    const agent = await registry.register(makeInput())
    let callCount = 0
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

    monitor = new HealthMonitor({
      registry,
      probeFn: async () => {
        const latency = latencies[callCount % latencies.length]!
        callCount++
        return { success: true, latencyMs: latency }
      },
    })

    // Probe multiple times
    for (let i = 0; i < 10; i++) {
      await monitor.probeAgent(agent.id)
    }

    const health = await monitor.probeAgent(agent.id)
    expect(health.latencyP50Ms).toBeDefined()
    expect(health.latencyP95Ms).toBeDefined()
    expect(health.latencyP99Ms).toBeDefined()
  })

  it('returns unknown health for non-existent agent', async () => {
    monitor = new HealthMonitor({
      registry,
      probeFn: createSuccessProbe(),
    })

    const health = await monitor.probeAgent('non-existent')
    expect(health.status).toBe('unknown')
  })

  it('returns unknown health for agent without endpoint', async () => {
    const agent = await registry.register(makeInput({ endpoint: undefined }))
    monitor = new HealthMonitor({
      registry,
      probeFn: createSuccessProbe(),
    })

    const health = await monitor.probeAgent(agent.id)
    expect(health.status).toBe('unknown')
  })

  it('start/stop lifecycle works correctly', () => {
    monitor = new HealthMonitor({
      registry,
      intervalMs: 100000,
      probeFn: createSuccessProbe(),
    })

    expect(monitor.isRunning).toBe(false)
    monitor.start()
    expect(monitor.isRunning).toBe(true)

    // Double start is safe
    monitor.start()
    expect(monitor.isRunning).toBe(true)

    monitor.stop()
    expect(monitor.isRunning).toBe(false)

    // Double stop is safe
    monitor.stop()
    expect(monitor.isRunning).toBe(false)
  })
})
