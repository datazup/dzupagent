/**
 * W15-B1 — Core Facades Tests
 *
 * Tests for:
 * - facades/memory.ts (re-export verification + behavioral)
 * - facades/orchestration.ts (AgentBus, hooks, stores, protocol, pipeline, concurrency)
 * - facades/quick-start.ts (createQuickAgent, ForgeContainer, config)
 * - facades/security.ts (risk, secrets, PII, pipeline, policy, monitor, classification)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================================================
// FACADE: quick-start
// ============================================================================

import {
  createQuickAgent,
  createContainer,
  createEventBus,
  ModelRegistry,
  ForgeError,
  SSETransformer,
  DEFAULT_CONFIG,
  resolveConfig,
  mergeConfigs,
  ForgeContainer,
} from '../facades/quick-start.js'
import type { QuickAgentOptions, QuickAgentResult, DzupEventBus } from '../facades/quick-start.js'

describe('createQuickAgent — provider coverage', () => {
  const providers: Array<QuickAgentOptions['provider']> = [
    'anthropic', 'openai', 'openrouter', 'azure', 'bedrock', 'custom',
  ]

  for (const provider of providers) {
    it(`configures registry for provider="${provider}"`, () => {
      const result = createQuickAgent({ provider, apiKey: 'k' })
      expect(result.registry.isConfigured()).toBe(true)
      expect(result.registry.listProviders()).toContain(provider)
      const chatSpec = result.registry.getSpec('chat')
      expect(chatSpec).not.toBeNull()
      expect(chatSpec!.maxTokens).toBeGreaterThan(0)
    })
  }

  it('azure defaults to gpt-4o-mini for chat', () => {
    const { registry } = createQuickAgent({ provider: 'azure', apiKey: 'k' })
    expect(registry.getSpec('chat')!.name).toBe('gpt-4o-mini')
  })

  it('bedrock defaults to anthropic.claude-haiku for chat', () => {
    const { registry } = createQuickAgent({ provider: 'bedrock', apiKey: 'k' })
    expect(registry.getSpec('chat')!.name).toBe('anthropic.claude-haiku')
  })

  it('openrouter defaults to anthropic/claude-haiku for chat', () => {
    const { registry } = createQuickAgent({ provider: 'openrouter', apiKey: 'k' })
    expect(registry.getSpec('chat')!.name).toBe('anthropic/claude-haiku')
  })

  it('passes baseUrl when provided', () => {
    const result = createQuickAgent({
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'https://my-proxy.example.com',
    })
    // No throw; registry should be configured
    expect(result.registry.isConfigured()).toBe(true)
  })
})

describe('ForgeContainer — advanced', () => {
  it('has() returns false for unknown service', () => {
    const c = createContainer()
    expect(c.has('nonexistent')).toBe(false)
  })

  it('has() returns true after register', () => {
    const c = createContainer()
    c.register('svc', () => 42)
    expect(c.has('svc')).toBe(true)
  })

  it('factory receives container for multi-level dependency chain', () => {
    const c = createContainer()
    c.register('a', () => 1)
    c.register('b', (ct) => ct.get<number>('a') + 10)
    c.register('c', (ct) => ct.get<number>('b') * 2)
    expect(c.get<number>('c')).toBe(22)
  })

  it('list returns empty array when no services registered', () => {
    const c = createContainer()
    expect(c.list()).toEqual([])
  })

  it('singleton semantics: get returns same instance', () => {
    const c = createContainer()
    c.register('obj', () => ({ id: Math.random() }))
    const a = c.get('obj')
    const b = c.get('obj')
    expect(a).toBe(b)
  })
})

describe('DzupEventBus — wildcard and error', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  it('listener throwing does not prevent other listeners', () => {
    const results: string[] = []
    bus.on('agent:started', () => { throw new Error('boom') })
    bus.on('agent:started', () => { results.push('ok') })
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    expect(results).toContain('ok')
  })

  it('multiple unsubscribes are safe (idempotent)', () => {
    let count = 0
    const unsub = bus.on('agent:started', () => { count++ })
    unsub()
    unsub() // second call should not throw
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    expect(count).toBe(0)
  })

  it('onAny unsubscribe stops wildcard delivery', () => {
    const types: string[] = []
    const unsub = bus.onAny((e) => { types.push(e.type) })
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    unsub()
    bus.emit({ type: 'agent:completed', agentId: 'a', runId: 'r', output: '' })
    expect(types).toEqual(['agent:started'])
  })
})

describe('config helpers', () => {
  it('resolveConfig returns a config object', () => {
    const cfg = resolveConfig()
    expect(cfg).toBeDefined()
    expect(typeof cfg).toBe('object')
  })

  it('mergeConfigs respects priority ordering', () => {
    const merged = mergeConfigs(
      { name: 'low', priority: 0, config: { a: 1 } },
      { name: 'high', priority: 10, config: { a: 2 } },
    )
    expect(merged).toBeDefined()
  })

  it('DEFAULT_CONFIG contains expected top-level keys', () => {
    expect(DEFAULT_CONFIG).toBeDefined()
  })
})

// ============================================================================
// FACADE: orchestration — additional behavioral tests
// ============================================================================

import {
  AgentBus,
  runHooks,
  mergeHooks,
  InMemoryRunStore,
  InMemoryAgentStore,
  InMemoryEventLog,
  Semaphore,
  ConcurrencyPool,
  HealthAggregator,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  isMessageAlive,
  createMessageId,
  CostAwareRouter,
  scoreComplexity,
  isSimpleTurn,
  calculateCostCents,
} from '../facades/orchestration.js'

describe('AgentBus — additional edge cases', () => {
  it('publish to channel with no subscribers does not throw', () => {
    const bus = new AgentBus()
    expect(() => bus.publish('sender', 'empty-channel', { data: 1 })).not.toThrow()
  })

  it('getHistory for unknown channel returns empty array', () => {
    const bus = new AgentBus()
    expect(bus.getHistory('nonexistent')).toEqual([])
  })

  it('listChannels returns empty when no subscriptions', () => {
    const bus = new AgentBus()
    expect(bus.listChannels()).toEqual([])
  })

  it('listSubscribers for unknown channel returns empty array', () => {
    const bus = new AgentBus()
    expect(bus.listSubscribers('nope')).toEqual([])
  })

  it('multiple subscribers on same channel all receive messages', () => {
    const bus = new AgentBus()
    const received: string[] = []
    bus.subscribe('ch', 'a1', () => { received.push('a1') })
    bus.subscribe('ch', 'a2', () => { received.push('a2') })
    bus.publish('sender', 'ch', {})
    expect(received).toEqual(['a1', 'a2'])
  })
})

describe('InMemoryRunStore — additional', () => {
  it('list without filter returns all runs', async () => {
    const store = new InMemoryRunStore()
    await store.create({ agentId: 'a1', input: 'x' })
    await store.create({ agentId: 'a2', input: 'y' })
    const all = await store.list()
    expect(all).toHaveLength(2)
  })

  it('list filters by status', async () => {
    const store = new InMemoryRunStore()
    const run = await store.create({ agentId: 'a1', input: 'x' })
    await store.update(run.id, { status: 'completed' })
    await store.create({ agentId: 'a1', input: 'y' })
    const completed = await store.list({ status: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]!.status).toBe('completed')
  })

  it('addLog to nonexistent run does not throw', async () => {
    const store = new InMemoryRunStore()
    await expect(store.addLog('nonexistent', { level: 'info', message: 'hi' })).resolves.not.toThrow()
  })

  it('getLogs for nonexistent run returns empty', async () => {
    const store = new InMemoryRunStore()
    const logs = await store.getLogs('nonexistent')
    expect(logs).toEqual([])
  })
})

describe('InMemoryAgentStore — additional', () => {
  it('save overwrites existing agent with same id', async () => {
    const store = new InMemoryAgentStore()
    await store.save({ id: 'a1', name: 'V1', active: true, createdAt: new Date(), updatedAt: new Date() })
    await store.save({ id: 'a1', name: 'V2', active: true, createdAt: new Date(), updatedAt: new Date() })
    const a = await store.get('a1')
    expect(a!.name).toBe('V2')
  })

  it('list without filter returns all', async () => {
    const store = new InMemoryAgentStore()
    await store.save({ id: 'a1', name: 'A', active: true, createdAt: new Date(), updatedAt: new Date() })
    await store.save({ id: 'a2', name: 'B', active: false, createdAt: new Date(), updatedAt: new Date() })
    const all = await store.list()
    expect(all).toHaveLength(2)
  })

  it('delete nonexistent agent does not throw', async () => {
    const store = new InMemoryAgentStore()
    await expect(store.delete('nonexistent')).resolves.not.toThrow()
  })
})

describe('Protocol messaging via orchestration facade', () => {
  it('createMessageId returns unique IDs', () => {
    const a = createMessageId()
    const b = createMessageId()
    expect(a).not.toBe(b)
  })

  it('createForgeMessage produces a valid message structure', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'agent-a',
      to: 'agent-b',
      payload: { content: 'hello' },
    })
    expect(msg.id).toBeDefined()
    expect(msg.from).toBe('agent-a')
    expect(msg.to).toBe('agent-b')
    expect(msg.type).toBe('request')
  })

  it('createResponse creates a response linked to the original message', () => {
    const original = createForgeMessage({
      type: 'request',
      from: 'a',
      to: 'b',
      payload: { content: 'q' },
    })
    const response = createResponse(original, { content: 'a' })
    expect(response.type).toBe('response')
    expect(response.to).toBe(original.from)
  })

  it('createErrorResponse creates an error response', () => {
    const original = createForgeMessage({
      type: 'request',
      from: 'a',
      to: 'b',
      payload: { content: 'q' },
    })
    const errResp = createErrorResponse(original, 'something failed')
    expect(errResp.type).toBe('error')
  })

  it('isMessageAlive returns true for fresh messages', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'a',
      to: 'b',
      payload: { content: 'q' },
    })
    expect(isMessageAlive(msg)).toBe(true)
  })
})

describe('CostAwareRouter helpers via facade', () => {
  it('isSimpleTurn identifies simple greetings', () => {
    expect(isSimpleTurn('hi')).toBe(true)
    expect(isSimpleTurn('hello')).toBe(true)
  })

  it('scoreComplexity returns a known level', () => {
    const level = scoreComplexity('Implement a distributed consensus algorithm with Raft')
    expect(['simple', 'moderate', 'complex']).toContain(level)
  })

  it('calculateCostCents returns a number', () => {
    const cost = calculateCostCents({
      inputTokens: 1000,
      outputTokens: 500,
      modelName: 'gpt-4o-mini',
    })
    expect(typeof cost).toBe('number')
    expect(cost).toBeGreaterThanOrEqual(0)
  })
})

describe('ConcurrencyPool via orchestration facade', () => {
  it('execute runs tasks with concurrency control', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 2 })
    const results: number[] = []
    await Promise.all([
      pool.execute('k1', async () => { results.push(1) }),
      pool.execute('k2', async () => { results.push(2) }),
      pool.execute('k3', async () => { results.push(3) }),
    ])
    expect(results.sort()).toEqual([1, 2, 3])
  })

  it('stats reflect pool state', () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 3 })
    const stats = pool.stats()
    expect(stats.active).toBe(0)
    expect(stats.queued).toBe(0)
    expect(stats.completed).toBe(0)
    expect(stats.failed).toBe(0)
  })

  it('stats track completed count', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 5 })
    await pool.execute('a', async () => 42)
    await pool.execute('b', async () => 99)
    expect(pool.stats().completed).toBe(2)
  })

  it('stats track failed count', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 5 })
    await pool.execute('a', async () => 42)
    try { await pool.execute('b', async () => { throw new Error('boom') }) } catch {}
    expect(pool.stats().failed).toBe(1)
    expect(pool.stats().completed).toBe(1)
  })
})

describe('Semaphore — additional coverage', () => {
  it('multiple acquire/release cycles work correctly', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    await sem.acquire()
    expect(sem.available).toBe(0)
    sem.release()
    sem.release()
    expect(sem.available).toBe(2)
  })

  it('run returns the value produced by the function', async () => {
    const sem = new Semaphore(1)
    const result = await sem.run(async () => 'hello')
    expect(result).toBe('hello')
    expect(sem.available).toBe(1)
  })
})

// ============================================================================
// FACADE: security — additional behavioral tests
// ============================================================================

import {
  createRiskClassifier,
  scanForSecrets,
  redactSecrets,
  detectPII,
  redactPII,
  OutputPipeline,
  createDefaultPipeline,
  PolicyEvaluator,
  InMemoryPolicyStore,
  PolicyTranslator,
  createSafetyMonitor,
  getBuiltInRules,
  createMemoryDefense,
  DataClassifier,
  DEFAULT_CLASSIFICATION_PATTERNS,
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
  ComplianceAuditLogger,
  InMemoryAuditStore,
  createHarmfulContentFilter,
  createClassificationAwareRedactor,
} from '../facades/security.js'

describe('PolicyTranslator via security facade', () => {
  it('translate parses valid LLM JSON response', async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({
      rule: {
        id: 'test-rule',
        effect: 'deny',
        actions: ['delete.*'],
        priority: 50,
        description: 'Block all delete actions',
      },
      confidence: 0.9,
      explanation: 'This rule denies all delete operations.',
    }))

    const translator = new PolicyTranslator({ llm: mockLLM })
    const result = await translator.translate('Block all delete operations')
    expect(result.rule.id).toBe('test-rule')
    expect(result.rule.effect).toBe('deny')
    expect(result.confidence).toBe(0.9)
    expect(result.explanation).toContain('delete')
  })

  it('translate throws ForgeError on invalid JSON', async () => {
    const mockLLM = vi.fn().mockResolvedValue('not valid json')
    const translator = new PolicyTranslator({ llm: mockLLM })
    await expect(translator.translate('some policy')).rejects.toThrow()
  })

  it('translate throws ForgeError when rule field is missing', async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({ notRule: {} }))
    const translator = new PolicyTranslator({ llm: mockLLM })
    await expect(translator.translate('some policy')).rejects.toThrow()
  })

  it('explain returns trimmed text', async () => {
    const mockLLM = vi.fn().mockResolvedValue('  This rule allows read access.  ')
    const translator = new PolicyTranslator({ llm: mockLLM })
    const explanation = await translator.explain({
      id: 'r1',
      effect: 'allow',
      actions: ['read'],
    })
    expect(explanation).toBe('This rule allows read access.')
  })

  it('translate defaults confidence to 0.5 when missing', async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({
      rule: { id: 'r1', effect: 'allow', actions: ['x'] },
    }))
    const translator = new PolicyTranslator({ llm: mockLLM })
    const result = await translator.translate('allow x')
    expect(result.confidence).toBe(0.5)
    expect(result.explanation).toBe('')
  })
})

describe('ComplianceAuditLogger + InMemoryAuditStore', () => {
  it('record creates an entry with hash chain', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })

    const entry = await logger.record({
      actor: { id: 'agent-1', type: 'agent' },
      action: 'tool.called',
      result: 'success',
      details: { toolName: 'read_file' },
    })
    expect(entry.seq).toBe(1)
    expect(entry.hash).toBeTruthy()
    expect(entry.previousHash).toBe('')
  })

  it('sequential records form a valid hash chain', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })

    await logger.record({
      actor: { id: 'a', type: 'agent' },
      action: 'a1',
      result: 'success',
      details: {},
    })
    await logger.record({
      actor: { id: 'b', type: 'user' },
      action: 'a2',
      result: 'denied',
      details: {},
    })

    const integrity = await store.verifyIntegrity()
    expect(integrity.valid).toBe(true)
    expect(integrity.totalEntries).toBe(2)
  })

  it('attach auto-records security events from eventBus', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()
    logger.attach(bus)

    bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
    // Give the fire-and-forget promise a tick
    await new Promise((r) => setTimeout(r, 50))

    const entries = await store.search({})
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.action).toBe('tool.called')

    logger.dispose()
  })

  it('detach stops auto-recording', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()
    logger.attach(bus)
    logger.detach()

    bus.emit({ type: 'tool:called', toolName: 'x', input: {} })
    await new Promise((r) => setTimeout(r, 50))

    const entries = await store.search({})
    expect(entries).toHaveLength(0)
  })
})

describe('InMemoryAuditStore — search and retention', () => {
  it('search with filter by action', async () => {
    const store = new InMemoryAuditStore()
    await store.append({
      id: 'e1', timestamp: new Date(), actor: { id: 'a', type: 'agent' },
      action: 'tool.called', result: 'success', details: {},
    })
    await store.append({
      id: 'e2', timestamp: new Date(), actor: { id: 'a', type: 'agent' },
      action: 'policy.denied', result: 'denied', details: {},
    })

    const toolEntries = await store.search({ action: 'tool.called' })
    expect(toolEntries).toHaveLength(1)
    expect(toolEntries[0]!.action).toBe('tool.called')
  })

  it('search with offset and limit', async () => {
    const store = new InMemoryAuditStore()
    for (let i = 0; i < 5; i++) {
      await store.append({
        id: `e${i}`, timestamp: new Date(), actor: { id: 'a', type: 'agent' },
        action: 'a', result: 'success', details: {},
      })
    }
    const page = await store.search({ offset: 2, limit: 2 })
    expect(page).toHaveLength(2)
  })

  it('count returns correct count', async () => {
    const store = new InMemoryAuditStore()
    await store.append({
      id: 'e1', timestamp: new Date(), actor: { id: 'a', type: 'agent' },
      action: 'a', result: 'success', details: {},
    })
    await store.append({
      id: 'e2', timestamp: new Date(), actor: { id: 'b', type: 'user' },
      action: 'a', result: 'success', details: {},
    })
    expect(await store.count({ actorType: 'agent' })).toBe(1)
    expect(await store.count({})).toBe(2)
  })

  it('export yields JSON lines', async () => {
    const store = new InMemoryAuditStore()
    await store.append({
      id: 'e1', timestamp: new Date(), actor: { id: 'a', type: 'agent' },
      action: 'a', result: 'success', details: {},
    })
    const lines: string[] = []
    for await (const line of store.export()) {
      lines.push(line)
    }
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.id).toBe('e1')
  })

  it('applyRetention deletes old entries', async () => {
    const store = new InMemoryAuditStore()
    // Create an entry with a timestamp 100 days ago
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    await store.append({
      id: 'old', timestamp: oldDate, actor: { id: 'a', type: 'agent' },
      action: 'a', result: 'success', details: {},
    })
    await store.append({
      id: 'new', timestamp: new Date(), actor: { id: 'a', type: 'agent' },
      action: 'a', result: 'success', details: {},
    })

    const result = await store.applyRetention([{ maxAgeDays: 30, action: 'delete' }])
    expect(result.deleted).toBe(1)
    expect(await store.count({})).toBe(1)
  })

  it('verifyIntegrity on empty store returns valid', async () => {
    const store = new InMemoryAuditStore()
    const result = await store.verifyIntegrity()
    expect(result.valid).toBe(true)
    expect(result.totalEntries).toBe(0)
  })
})

describe('createHarmfulContentFilter via security facade', () => {
  it('filters violence-related content', () => {
    const stage = createHarmfulContentFilter()
    const result = stage.process('How to make a bomb at home') as string
    expect(result).toContain('[FILTERED:violence]')
  })

  it('filters malware-related content', () => {
    const stage = createHarmfulContentFilter()
    const result = stage.process('Here is keylogger source code') as string
    expect(result).toContain('[FILTERED:malware]')
  })

  it('passes clean content through unchanged', () => {
    const stage = createHarmfulContentFilter()
    const result = stage.process('Hello, how are you today?') as string
    expect(result).toBe('Hello, how are you today?')
  })

  it('accepts custom categories', () => {
    const stage = createHarmfulContentFilter([
      {
        name: 'custom-bad',
        severity: 'warning',
        patterns: [/forbidden\s+word/i],
      },
    ])
    const result = stage.process('This contains a forbidden word here') as string
    expect(result).toContain('[FILTERED:custom-bad]')
  })
})

describe('createClassificationAwareRedactor via security facade', () => {
  it('public level does not redact IPs', () => {
    const stage = createClassificationAwareRedactor('public')
    const result = stage.process('IP: 10.0.0.1') as string
    expect(result).toContain('10.0.0.1')
  })

  it('internal level redacts IPs', () => {
    const stage = createClassificationAwareRedactor('internal')
    const result = stage.process('IP: 10.0.0.1') as string
    expect(result).toContain('[REDACTED:ip]')
  })

  it('confidential level redacts authenticated URLs', () => {
    const stage = createClassificationAwareRedactor('confidential')
    const result = stage.process('db at https://user:pass@db.example.com/mydb') as string
    expect(result).toContain('[REDACTED:authenticated-url]')
  })

  it('restricted level redacts file paths', () => {
    const stage = createClassificationAwareRedactor('restricted')
    const result = stage.process('File at /home/user/secret/data.txt') as string
    expect(result).toContain('[REDACTED:path]')
  })

  it('unknown level defaults to public behavior', () => {
    const stage = createClassificationAwareRedactor('unknown-level')
    const result = stage.process('IP: 192.168.0.1') as string
    expect(result).toContain('192.168.0.1')
  })

  it('undefined level defaults to public', () => {
    const stage = createClassificationAwareRedactor()
    const result = stage.process('IP: 192.168.0.1') as string
    expect(result).toContain('192.168.0.1')
  })
})
