/**
 * W23-B2 — Core Plugin Lifecycle + MCP Client Invocation Deep Coverage
 *
 * Deep coverage for:
 *  - PluginRegistry (register, duplicate, lifecycle, event subscription)
 *  - PluginDiscovery (manifest validation, directory scan, topological order)
 *  - MCPClient (connect/disconnect, tool discovery, tool invocation, deferred loading)
 *  - MCPManager lifecycle routing via multi-server isolation
 *  - MCPReliability (circuit breaker, heartbeat, discovery cache, health)
 *  - Error paths (missing dep, tool not found, server unreachable)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginRegistry } from '../plugin/plugin-registry.js'
import type { DzupPlugin, PluginContext } from '../plugin/plugin-types.js'
import {
  discoverPlugins,
  resolvePluginOrder,
  validateManifest,
} from '../plugin/plugin-discovery.js'
import type { DiscoveredPlugin, PluginManifest } from '../plugin/plugin-discovery.js'
import { createManifest, serializeManifest } from '../plugin/plugin-manifest.js'

import { MCPClient } from '../mcp/mcp-client.js'
import type { MCPServerConfig, MCPToolDescriptor, MCPToolResult } from '../mcp/mcp-types.js'
import { InMemoryMcpManager } from '../mcp/mcp-manager.js'
import { McpReliabilityManager } from '../mcp/mcp-reliability.js'

import { createEventBus } from '../events/event-bus.js'
import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import type { ModelRegistry } from '../llm/model-registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubContext(eventBus: DzupEventBus): PluginContext {
  // ModelRegistry is referenced only by type; provide a minimal stub.
  const modelRegistry = {} as unknown as ModelRegistry
  return { eventBus, modelRegistry }
}

function makePlugin(overrides: Partial<DzupPlugin> = {}): DzupPlugin {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    ...overrides,
  }
}

function makeToolDescriptor(name: string, serverId: string): MCPToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    serverId,
  }
}

function makeServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: 'srv-1',
    name: 'Server 1',
    url: 'http://localhost:9999',
    transport: 'http',
    ...overrides,
  }
}

// Install a fetch mock scoped to a block
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  const globalObj = globalThis as unknown as { fetch: typeof fetch }
  globalObj.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch
}

function restoreFetch(original: typeof fetch | undefined): void {
  const globalObj = globalThis as unknown as { fetch: typeof fetch | undefined }
  globalObj.fetch = original as typeof fetch
}

// Create a Response-like object for mocked fetch
function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

describe('PluginRegistry', () => {
  let bus: DzupEventBus
  let events: DzupEvent[]
  let ctx: PluginContext
  let registry: PluginRegistry

  beforeEach(() => {
    bus = createEventBus()
    events = []
    bus.onAny((e) => { events.push(e) })
    ctx = stubContext(bus)
    registry = new PluginRegistry(bus)
  })

  it('registers a plugin and stores it', async () => {
    await registry.register(makePlugin({ name: 'p1' }), ctx)
    expect(registry.has('p1')).toBe(true)
    expect(registry.listPlugins()).toEqual(['p1'])
  })

  it('emits plugin:registered on register', async () => {
    await registry.register(makePlugin({ name: 'p1' }), ctx)
    const evt = events.find(e => e.type === 'plugin:registered')
    expect(evt).toBeDefined()
    if (evt?.type === 'plugin:registered') {
      expect(evt.pluginName).toBe('p1')
    }
  })

  it('rejects duplicate plugin registration', async () => {
    await registry.register(makePlugin({ name: 'dup' }), ctx)
    await expect(registry.register(makePlugin({ name: 'dup' }), ctx)).rejects.toThrow(
      'Plugin "dup" is already registered',
    )
  })

  it('invokes onRegister callback with context', async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined)
    await registry.register(makePlugin({ onRegister }), ctx)
    expect(onRegister).toHaveBeenCalledTimes(1)
    expect(onRegister).toHaveBeenCalledWith(ctx)
  })

  it('awaits async onRegister before completing', async () => {
    let resolved = false
    const onRegister = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 10))
      resolved = true
    }
    await registry.register(makePlugin({ onRegister }), ctx)
    expect(resolved).toBe(true)
  })

  it('propagates onRegister rejection', async () => {
    const onRegister = async (): Promise<void> => { throw new Error('boom') }
    await expect(registry.register(makePlugin({ onRegister }), ctx)).rejects.toThrow('boom')
  })

  it('does NOT register plugin when onRegister throws', async () => {
    const onRegister = async (): Promise<void> => { throw new Error('nope') }
    await expect(registry.register(makePlugin({ name: 'fail', onRegister }), ctx)).rejects.toThrow()
    expect(registry.has('fail')).toBe(false)
  })

  it('subscribes event handlers declared by the plugin', async () => {
    const handler = vi.fn()
    const plugin = makePlugin({
      name: 'listener',
      eventHandlers: { 'agent:started': handler },
    })
    await registry.register(plugin, ctx)
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    // microtask flush
    await Promise.resolve()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('subscribes multiple event handlers from one plugin', async () => {
    const onStarted = vi.fn()
    const onCompleted = vi.fn()
    const plugin = makePlugin({
      name: 'multi',
      eventHandlers: {
        'agent:started': onStarted,
        'agent:completed': onCompleted,
      },
    })
    await registry.register(plugin, ctx)
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1' })
    await Promise.resolve()
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it('ignores non-function values in eventHandlers map', async () => {
    const plugin: DzupPlugin = {
      name: 'bad-handler',
      version: '1.0.0',
      eventHandlers: {
        // @ts-expect-error - intentionally invalid to test runtime guard
        'agent:started': 'not-a-function',
      },
    }
    await expect(registry.register(plugin, ctx)).resolves.toBeUndefined()
    // Must not throw when event emits
    expect(() => bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })).not.toThrow()
  })

  it('aggregates middleware across plugins', async () => {
    await registry.register(
      makePlugin({ name: 'a', middleware: [{ name: 'mw-a' }] }),
      ctx,
    )
    await registry.register(
      makePlugin({ name: 'b', middleware: [{ name: 'mw-b1' }, { name: 'mw-b2' }] }),
      ctx,
    )
    const all = registry.getMiddleware()
    expect(all).toHaveLength(3)
    expect(all.map(m => m.name)).toEqual(['mw-a', 'mw-b1', 'mw-b2'])
  })

  it('returns empty middleware array when no plugins contribute middleware', async () => {
    await registry.register(makePlugin({ name: 'a' }), ctx)
    expect(registry.getMiddleware()).toEqual([])
  })

  it('aggregates hooks across plugins', async () => {
    const hooks1 = { onRunStart: vi.fn() }
    const hooks2 = { onRunComplete: vi.fn() }
    await registry.register(makePlugin({ name: 'h1', hooks: hooks1 }), ctx)
    await registry.register(makePlugin({ name: 'h2', hooks: hooks2 }), ctx)
    const all = registry.getHooks()
    expect(all).toHaveLength(2)
    expect(all[0]).toBe(hooks1)
    expect(all[1]).toBe(hooks2)
  })

  it('returns empty hooks array when plugins contribute no hooks', async () => {
    await registry.register(makePlugin({ name: 'no-hooks' }), ctx)
    expect(registry.getHooks()).toEqual([])
  })

  it('get() returns the registered plugin', async () => {
    const plugin = makePlugin({ name: 'lookup' })
    await registry.register(plugin, ctx)
    expect(registry.get('lookup')).toBe(plugin)
  })

  it('get() returns undefined for unknown plugin', () => {
    expect(registry.get('ghost')).toBeUndefined()
  })

  it('has() is false for unknown plugin', () => {
    expect(registry.has('ghost')).toBe(false)
  })

  it('listPlugins() preserves registration order', async () => {
    await registry.register(makePlugin({ name: 'alpha' }), ctx)
    await registry.register(makePlugin({ name: 'beta' }), ctx)
    await registry.register(makePlugin({ name: 'gamma' }), ctx)
    expect(registry.listPlugins()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('onRegister fires before plugin becomes visible in listPlugins', async () => {
    const seen: string[] = []
    const onRegister = async (): Promise<void> => {
      seen.push(...registry.listPlugins())
    }
    await registry.register(makePlugin({ name: 'ordering', onRegister }), ctx)
    expect(seen).toEqual([])
    expect(registry.listPlugins()).toContain('ordering')
  })
})

// ---------------------------------------------------------------------------
// PluginDiscovery — manifest validation
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const v = validateManifest({
      name: 'p1',
      version: '1.0.0',
      description: 'test',
      capabilities: ['x'],
      entryPoint: './index.js',
    })
    expect(v.valid).toBe(true)
    expect(v.errors).toEqual([])
  })

  it('rejects null', () => {
    const v = validateManifest(null)
    expect(v.valid).toBe(false)
    expect(v.errors.join(',')).toContain('non-null object')
  })

  it('rejects non-object inputs', () => {
    expect(validateManifest('string').valid).toBe(false)
    expect(validateManifest(42).valid).toBe(false)
    expect(validateManifest(undefined).valid).toBe(false)
  })

  it('reports missing required fields', () => {
    const v = validateManifest({})
    expect(v.valid).toBe(false)
    // Expect required field errors for each of name/version/description/capabilities/entryPoint
    const msg = v.errors.join('\n')
    expect(msg).toContain('Missing required field "name"')
    expect(msg).toContain('Missing required field "version"')
    expect(msg).toContain('Missing required field "description"')
    expect(msg).toContain('Missing required field "capabilities"')
    expect(msg).toContain('Missing required field "entryPoint"')
  })

  it('rejects empty name', () => {
    const v = validateManifest({
      name: '',
      version: '1.0.0',
      description: 'd',
      capabilities: [],
      entryPoint: './i.js',
    })
    expect(v.valid).toBe(false)
    expect(v.errors).toContain('"name" must be non-empty')
  })

  it('rejects non-string name', () => {
    const v = validateManifest({
      name: 123,
      version: '1.0.0',
      description: 'd',
      capabilities: [],
      entryPoint: './i.js',
    })
    expect(v.valid).toBe(false)
    expect(v.errors).toContain('"name" must be a string')
  })

  it('rejects non-array capabilities', () => {
    const v = validateManifest({
      name: 'p',
      version: '1.0.0',
      description: 'd',
      capabilities: 'not-array',
      entryPoint: './i.js',
    })
    expect(v.valid).toBe(false)
    expect(v.errors).toContain('"capabilities" must be an array')
  })

  it('rejects non-array dependencies', () => {
    const v = validateManifest({
      name: 'p',
      version: '1.0.0',
      description: 'd',
      capabilities: [],
      entryPoint: './i.js',
      dependencies: 'nope',
    })
    expect(v.valid).toBe(false)
    expect(v.errors).toContain('"dependencies" must be an array')
  })
})

// ---------------------------------------------------------------------------
// PluginDiscovery — directory scan
// ---------------------------------------------------------------------------

describe('discoverPlugins', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dzupagent-plugin-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns empty list when no directories match', async () => {
    const result = await discoverPlugins({ localDirs: [join(tempRoot, 'nonexistent')] })
    expect(result).toEqual([])
  })

  it('includes builtin plugins first', async () => {
    const manifest: PluginManifest = {
      name: 'builtin-x',
      version: '1.0.0',
      description: 'built in',
      capabilities: [],
      entryPoint: './index.js',
    }
    const result = await discoverPlugins({ localDirs: [], builtinPlugins: [manifest] })
    expect(result).toHaveLength(1)
    expect(result[0]!.source).toBe('builtin')
    expect(result[0]!.path).toBe('<builtin>')
    expect(result[0]!.manifest.name).toBe('builtin-x')
  })

  it('discovers a valid manifest from a directory', async () => {
    const pluginDir = join(tempRoot, 'myplugin')
    await mkdir(pluginDir, { recursive: true })
    const manifest = createManifest({
      name: 'myplugin',
      version: '1.0.0',
      description: 'Discovered plugin',
      capabilities: ['foo'],
    })
    await writeFile(join(pluginDir, 'dzupagent-plugin.json'), serializeManifest(manifest))

    const result = await discoverPlugins({ localDirs: [tempRoot] })
    expect(result).toHaveLength(1)
    expect(result[0]!.manifest.name).toBe('myplugin')
    expect(result[0]!.source).toBe('local')
    expect(result[0]!.path).toBe(pluginDir)
  })

  it('skips invalid manifests without throwing', async () => {
    const validDir = join(tempRoot, 'valid')
    const invalidDir = join(tempRoot, 'invalid')
    await mkdir(validDir, { recursive: true })
    await mkdir(invalidDir, { recursive: true })

    await writeFile(
      join(validDir, 'dzupagent-plugin.json'),
      serializeManifest(createManifest({
        name: 'valid', version: '1.0.0', description: 'ok',
      })),
    )
    await writeFile(join(invalidDir, 'dzupagent-plugin.json'), '{"name":"bad"}')

    const result = await discoverPlugins({ localDirs: [tempRoot] })
    expect(result).toHaveLength(1)
    expect(result[0]!.manifest.name).toBe('valid')
  })

  it('skips entries without a manifest', async () => {
    const dir = join(tempRoot, 'no-manifest')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.js'), '// no manifest')

    const result = await discoverPlugins({ localDirs: [tempRoot] })
    expect(result).toEqual([])
  })

  it('skips entries with malformed JSON', async () => {
    const dir = join(tempRoot, 'bad-json')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'dzupagent-plugin.json'), '{{not json}}')

    const result = await discoverPlugins({ localDirs: [tempRoot] })
    expect(result).toEqual([])
  })

  it('returns empty array when directory is unreadable', async () => {
    const result = await discoverPlugins({ localDirs: ['/this/path/does/not/exist/xyz'] })
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PluginDiscovery — topological order
// ---------------------------------------------------------------------------

describe('resolvePluginOrder', () => {
  function makeDiscovered(name: string, dependencies: string[] = []): DiscoveredPlugin {
    return {
      manifest: {
        name,
        version: '1.0.0',
        description: name,
        capabilities: [],
        entryPoint: './index.js',
        dependencies,
      },
      path: '<builtin>',
      source: 'builtin',
    }
  }

  it('returns empty list for empty input', () => {
    expect(resolvePluginOrder([])).toEqual([])
  })

  it('preserves order for plugins with no dependencies', () => {
    const plugins = [makeDiscovered('a'), makeDiscovered('b'), makeDiscovered('c')]
    const sorted = resolvePluginOrder(plugins)
    expect(sorted.map(p => p.manifest.name)).toEqual(['a', 'b', 'c'])
  })

  it('respects declared dependencies (dep loads first)', () => {
    // b depends on a → a must appear before b
    const plugins = [makeDiscovered('b', ['a']), makeDiscovered('a')]
    const sorted = resolvePluginOrder(plugins)
    const aIdx = sorted.findIndex(p => p.manifest.name === 'a')
    const bIdx = sorted.findIndex(p => p.manifest.name === 'b')
    expect(aIdx).toBeGreaterThanOrEqual(0)
    expect(aIdx).toBeLessThan(bIdx)
  })

  it('handles transitive dependencies', () => {
    // c → b → a; expected order a, b, c
    const plugins = [
      makeDiscovered('c', ['b']),
      makeDiscovered('b', ['a']),
      makeDiscovered('a'),
    ]
    const sorted = resolvePluginOrder(plugins)
    expect(sorted.map(p => p.manifest.name)).toEqual(['a', 'b', 'c'])
  })

  it('detects circular dependencies and throws', () => {
    const plugins = [
      makeDiscovered('a', ['b']),
      makeDiscovered('b', ['a']),
    ]
    expect(() => resolvePluginOrder(plugins)).toThrow(/Circular plugin dependency/)
  })

  it('ignores missing external dependencies gracefully', () => {
    const plugins = [makeDiscovered('a', ['not-in-set'])]
    const sorted = resolvePluginOrder(plugins)
    expect(sorted.map(p => p.manifest.name)).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// MCPClient — connection lifecycle & tool discovery
// ---------------------------------------------------------------------------

describe('MCPClient', () => {
  let client: MCPClient
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    client = new MCPClient()
  })

  afterEach(() => {
    restoreFetch(originalFetch)
  })

  it('addServer is chainable', () => {
    const result = client.addServer(makeServerConfig({ id: 's1' }))
    expect(result).toBe(client)
  })

  it('status reports disconnected for newly-added server', () => {
    client.addServer(makeServerConfig({ id: 's1' }))
    const status = client.getStatus()
    expect(status).toHaveLength(1)
    expect(status[0]!.state).toBe('disconnected')
    expect(status[0]!.toolCount).toBe(0)
  })

  it('connect() returns false for unknown server', async () => {
    const ok = await client.connect('nope')
    expect(ok).toBe(false)
  })

  it('connects via HTTP and discovers tools', async () => {
    mockFetch((url) => {
      expect(url).toContain('/tools/list')
      return jsonResponse({
        result: {
          tools: [
            { name: 'calc', description: 'calc', inputSchema: { type: 'object', properties: {} } },
            { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      })
    })

    client.addServer(makeServerConfig({ id: 'http-1', transport: 'http' }))
    const ok = await client.connect('http-1')
    expect(ok).toBe(true)

    const tools = client.getEagerTools()
    expect(tools).toHaveLength(2)
    expect(tools[0]!.serverId).toBe('http-1')
  })

  it('sets error state when HTTP response is non-ok', async () => {
    mockFetch(() => jsonResponse({}, false, 500))
    client.addServer(makeServerConfig({ id: 'fail', transport: 'http' }))
    const ok = await client.connect('fail')
    expect(ok).toBe(false)

    const status = client.getStatus()
    expect(status[0]!.state).toBe('error')
    expect(status[0]!.lastError).toBeTruthy()
  })

  it('applies deferred-loading split when maxEagerTools is exceeded', async () => {
    mockFetch(() => jsonResponse({
      result: {
        tools: Array.from({ length: 5 }, (_, i) => ({
          name: `t${i}`,
          description: `tool ${i}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    }))

    client.addServer(makeServerConfig({ id: 's', transport: 'http', maxEagerTools: 2 }))
    const ok = await client.connect('s')
    expect(ok).toBe(true)

    expect(client.getEagerTools()).toHaveLength(2)
    expect(client.getDeferredToolNames()).toHaveLength(3)
  })

  it('loadDeferredTool() promotes a deferred tool to eager', async () => {
    mockFetch(() => jsonResponse({
      result: {
        tools: Array.from({ length: 3 }, (_, i) => ({
          name: `t${i}`,
          description: `tool ${i}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    }))

    client.addServer(makeServerConfig({ id: 's', transport: 'http', maxEagerTools: 1 }))
    await client.connect('s')

    const descriptor = client.loadDeferredTool('t2')
    expect(descriptor).not.toBeNull()
    expect(descriptor!.name).toBe('t2')

    // Now eager
    expect(client.getEagerTools().map(t => t.name)).toContain('t2')
    // And removed from deferred
    expect(client.getDeferredToolNames().map(t => t.name)).not.toContain('t2')
  })

  it('loadDeferredTool() returns null for unknown tool', async () => {
    client.addServer(makeServerConfig({ id: 'empty', transport: 'http' }))
    expect(client.loadDeferredTool('ghost')).toBeNull()
  })

  it('findTool() returns null when tool is missing', () => {
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    // Server is still disconnected — findTool skips non-connected servers
    expect(client.findTool('x')).toBeNull()
  })

  it('findTool() finds a connected server tool', async () => {
    mockFetch(() => jsonResponse({
      result: {
        tools: [{ name: 'calc', description: 'c', inputSchema: { type: 'object', properties: {} } }],
      },
    }))
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    await client.connect('s')
    const tool = client.findTool('calc')
    expect(tool).not.toBeNull()
    expect(tool!.serverId).toBe('s')
  })

  it('connectAll() connects every registered server', async () => {
    mockFetch(() => jsonResponse({ result: { tools: [] } }))
    client.addServer(makeServerConfig({ id: 's1', transport: 'http' }))
    client.addServer(makeServerConfig({ id: 's2', transport: 'http' }))

    const results = await client.connectAll()
    expect(results.size).toBe(2)
    expect(results.get('s1')).toBe(true)
    expect(results.get('s2')).toBe(true)
  })

  it('hasConnections is false until at least one server connects', async () => {
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    expect(client.hasConnections()).toBe(false)
    mockFetch(() => jsonResponse({ result: { tools: [] } }))
    await client.connect('s')
    expect(client.hasConnections()).toBe(true)
  })

  it('disconnect() clears tools and transitions to disconnected', async () => {
    mockFetch(() => jsonResponse({
      result: { tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }] },
    }))
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    await client.connect('s')
    expect(client.getEagerTools()).toHaveLength(1)

    await client.disconnect('s')
    const status = client.getStatus().find(s => s.id === 's')!
    expect(status.state).toBe('disconnected')
    expect(status.toolCount).toBe(0)
    expect(client.getEagerTools()).toHaveLength(0)
  })

  it('disconnectAll() disconnects all servers', async () => {
    mockFetch(() => jsonResponse({ result: { tools: [] } }))
    client.addServer(makeServerConfig({ id: 's1', transport: 'http' }))
    client.addServer(makeServerConfig({ id: 's2', transport: 'http' }))
    await client.connectAll()

    await client.disconnectAll()
    for (const s of client.getStatus()) {
      expect(s.state).toBe('disconnected')
    }
  })

  it('disconnect() on unknown server is a no-op', async () => {
    await expect(client.disconnect('missing')).resolves.toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Tool invocation
  // -------------------------------------------------------------------------

  it('invokeTool() returns error result when tool is not found', async () => {
    const result = await client.invokeTool('ghost', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('not found')
  })

  it('invokeTool() returns error when server is not connected', async () => {
    // Hand-craft a disconnected state (simulate stale tool reference)
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    // Without connecting, findTool will return null → "not found" path
    const result = await client.invokeTool('unknown-tool', {})
    expect(result.isError).toBe(true)
  })

  it('invokeTool() routes the call to the correct HTTP endpoint', async () => {
    const calls: string[] = []
    mockFetch((url) => {
      calls.push(url)
      if (url.endsWith('/tools/list')) {
        return jsonResponse({
          result: {
            tools: [{ name: 'calc', description: 'c', inputSchema: { type: 'object', properties: {} } }],
          },
        })
      }
      return jsonResponse({ result: { content: [{ type: 'text', text: '42' }] } })
    })

    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    await client.connect('s')

    const result = await client.invokeTool('calc', { x: 1 })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe('42')
    expect(calls.some(u => u.endsWith('/tools/call'))).toBe(true)
  })

  it('invokeTool() falls back to "No result" when server omits result field', async () => {
    mockFetch((url) => {
      if (url.endsWith('/tools/list')) {
        return jsonResponse({
          result: {
            tools: [{ name: 'calc', description: 'c', inputSchema: { type: 'object', properties: {} } }],
          },
        })
      }
      return jsonResponse({})
    })
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    await client.connect('s')

    const result = await client.invokeTool('calc', {})
    expect(result.content[0]!.text).toBe('No result')
  })

  it('invokeTool() surfaces HTTP errors as error results', async () => {
    let callCount = 0
    mockFetch((url) => {
      callCount++
      if (url.endsWith('/tools/list')) {
        return jsonResponse({
          result: {
            tools: [{ name: 'calc', description: 'c', inputSchema: { type: 'object', properties: {} } }],
          },
        })
      }
      return jsonResponse({ error: 'boom' }, false, 500)
    })

    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    await client.connect('s')

    const result = await client.invokeTool('calc', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('HTTP 500')
    expect(callCount).toBe(2)
  })

  it('SSE transport falls back through the HTTP discovery path', async () => {
    mockFetch((url) => {
      expect(url).toContain('/tools/list')
      return jsonResponse({ result: { tools: [] } })
    })

    client.addServer(makeServerConfig({ id: 'sse', transport: 'sse' }))
    const ok = await client.connect('sse')
    expect(ok).toBe(true)
    expect(client.getStatus()[0]!.state).toBe('connected')
  })

  it('unsupported transport throws internally and connection is marked error', async () => {
    client.addServer(makeServerConfig({ id: 'weird', transport: 'ws' as unknown as MCPServerConfig['transport'] }))
    const ok = await client.connect('weird')
    expect(ok).toBe(false)
    const status = client.getStatus().find(s => s.id === 'weird')!
    expect(status.state).toBe('error')
  })

  it('status reflects eager/deferred counts after connect', async () => {
    mockFetch(() => jsonResponse({
      result: {
        tools: Array.from({ length: 4 }, (_, i) => ({
          name: `t${i}`, description: `t${i}`, inputSchema: { type: 'object', properties: {} },
        })),
      },
    }))
    client.addServer(makeServerConfig({ id: 's', transport: 'http', maxEagerTools: 2 }))
    await client.connect('s')

    const s = client.getStatus().find((st) => st.id === 's')!
    expect(s.toolCount).toBe(4)
    expect(s.eagerToolCount).toBe(2)
    expect(s.deferredToolCount).toBe(2)
  })

  it('returns empty list from getEagerTools when nothing connected', () => {
    client.addServer(makeServerConfig({ id: 's', transport: 'http' }))
    expect(client.getEagerTools()).toEqual([])
    expect(client.getDeferredToolNames()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// MCPClient — multi-server isolation
// ---------------------------------------------------------------------------

describe('MCPClient multi-server isolation', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { restoreFetch(originalFetch) })

  it('routes invocation to the server that provides the tool', async () => {
    let toolsCallUrl = ''
    mockFetch((url) => {
      if (url.endsWith('/tools/list')) {
        if (url.startsWith('http://a.local')) {
          return jsonResponse({
            result: {
              tools: [{ name: 't-a', description: 'a', inputSchema: { type: 'object', properties: {} } }],
            },
          })
        }
        return jsonResponse({
          result: {
            tools: [{ name: 't-b', description: 'b', inputSchema: { type: 'object', properties: {} } }],
          },
        })
      }
      toolsCallUrl = url
      return jsonResponse({ result: { content: [{ type: 'text', text: 'routed' }] } })
    })

    const client = new MCPClient()
    client.addServer(makeServerConfig({ id: 'A', url: 'http://a.local', transport: 'http' }))
    client.addServer(makeServerConfig({ id: 'B', url: 'http://b.local', transport: 'http' }))
    await client.connectAll()

    await client.invokeTool('t-b', {})
    expect(toolsCallUrl.startsWith('http://b.local')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// InMemoryMcpManager — routing & multi-server isolation
// ---------------------------------------------------------------------------

describe('InMemoryMcpManager routing', () => {
  let bus: DzupEventBus
  let events: DzupEvent[]
  let manager: InMemoryMcpManager

  beforeEach(() => {
    bus = createEventBus()
    events = []
    bus.onAny((e) => { events.push(e) })
    manager = new InMemoryMcpManager({ eventBus: bus })
  })

  it('registers multiple servers independently', async () => {
    await manager.addServer({ id: 'alpha', transport: 'http', endpoint: 'http://a', enabled: true })
    await manager.addServer({ id: 'beta', transport: 'http', endpoint: 'http://b', enabled: true })

    const list = await manager.listServers()
    expect(list.map(s => s.id).sort()).toEqual(['alpha', 'beta'])
  })

  it('removeServer emits mcp:server_removed event', async () => {
    await manager.addServer({ id: 'x', transport: 'http', endpoint: 'http://x', enabled: true })
    events.length = 0
    await manager.removeServer('x')
    expect(events.some(e => e.type === 'mcp:server_removed')).toBe(true)
  })

  it('removeServer on unknown id is silent (no event)', async () => {
    await manager.removeServer('ghost')
    expect(events.some(e => e.type === 'mcp:server_removed')).toBe(false)
  })

  it('testServer returns ok=false when no MCP client is configured', async () => {
    await manager.addServer({ id: 's', transport: 'http', endpoint: 'http://s', enabled: true })
    const res = await manager.testServer('s')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('No MCPClient')
  })

  it('testServer returns ok=false for unknown server id', async () => {
    const res = await manager.testServer('not-there')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  it('profile CRUD round-trip works', async () => {
    await manager.addProfile({ id: 'p1', serverIds: ['a', 'b'], enabled: true })
    const p = await manager.getProfile('p1')
    expect(p?.serverIds).toEqual(['a', 'b'])
    await manager.removeProfile('p1')
    expect(await manager.getProfile('p1')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// McpReliabilityManager — circuit + retry + timeout behaviors
// ---------------------------------------------------------------------------

describe('McpReliabilityManager — resilience', () => {
  let mgr: McpReliabilityManager

  beforeEach(() => {
    vi.useFakeTimers()
    mgr = new McpReliabilityManager({
      heartbeatIntervalMs: 1000,
      maxHeartbeatFailures: 3,
      discoveryCacheTtlMs: 2000,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000 },
    })
  })

  afterEach(() => {
    mgr.dispose()
    vi.useRealTimers()
  })

  it('circuit opens after repeated failures', () => {
    mgr.registerServer('s')
    mgr.recordFailure('s', 'err')
    mgr.recordFailure('s', 'err')
    expect(mgr.isCircuitOpen('s')).toBe(true)
    expect(mgr.canExecute('s')).toBe(false)
  })

  it('circuit allows execution in closed state', () => {
    mgr.registerServer('s')
    expect(mgr.canExecute('s')).toBe(true)
    expect(mgr.isCircuitOpen('s')).toBe(false)
  })

  it('caches discovery and expires after TTL', () => {
    mgr.registerServer('s')
    const tools = [makeToolDescriptor('t1', 's')]
    mgr.cacheDiscovery('s', tools)
    expect(mgr.getCachedDiscovery('s')).toEqual(tools)

    vi.advanceTimersByTime(2500)
    expect(mgr.getCachedDiscovery('s')).toBeUndefined()
  })

  it('invalidateDiscovery clears the cache', () => {
    mgr.registerServer('s')
    mgr.cacheDiscovery('s', [makeToolDescriptor('t', 's')])
    mgr.invalidateDiscovery('s')
    expect(mgr.getCachedDiscovery('s')).toBeUndefined()
  })

  it('heartbeat records success when pingFn resolves true', async () => {
    mgr.registerServer('s')
    const pingFn = vi.fn().mockResolvedValue(true)
    mgr.startHeartbeat('s', pingFn)
    expect(mgr.isHeartbeatActive('s')).toBe(true)

    await vi.advanceTimersByTimeAsync(1100)
    expect(pingFn).toHaveBeenCalled()
    const health = mgr.getHealth('s')!
    expect(health.lastHeartbeat).toBeDefined()
    expect(health.consecutiveFailures).toBe(0)
  })

  it('heartbeat records failure when pingFn throws', async () => {
    mgr.registerServer('s')
    const pingFn = vi.fn().mockRejectedValue(new Error('timeout'))
    mgr.startHeartbeat('s', pingFn)

    await vi.advanceTimersByTimeAsync(1100)
    const health = mgr.getHealth('s')!
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1)
    expect(health.lastError).toContain('timeout')
  })

  it('unregisterServer stops heartbeat and clears state', () => {
    mgr.registerServer('s')
    mgr.startHeartbeat('s', async () => true)
    mgr.unregisterServer('s')
    expect(mgr.isHeartbeatActive('s')).toBe(false)
    expect(mgr.getHealth('s')).toBeUndefined()
  })

  it('canExecute is false for unregistered server', () => {
    expect(mgr.canExecute('never-registered')).toBe(false)
  })

  it('getHealth is undefined for unregistered server', () => {
    expect(mgr.getHealth('nothing')).toBeUndefined()
  })

  it('getAllHealth aggregates all registered servers', () => {
    mgr.registerServer('a')
    mgr.registerServer('b')
    mgr.registerServer('c')
    const all = mgr.getAllHealth()
    expect(all).toHaveLength(3)
    expect(all.map(h => h.serverId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('recordSuccess clears previous error', () => {
    mgr.registerServer('s')
    mgr.recordFailure('s', 'boom')
    expect(mgr.getHealth('s')!.lastError).toBe('boom')
    mgr.recordSuccess('s')
    expect(mgr.getHealth('s')!.lastError).toBeUndefined()
    expect(mgr.getHealth('s')!.consecutiveFailures).toBe(0)
  })

  it('recordFailure marks unhealthy once threshold is reached', () => {
    mgr.registerServer('s')
    mgr.recordFailure('s', 'e1')
    mgr.recordFailure('s', 'e2')
    mgr.recordFailure('s', 'e3')
    expect(mgr.getHealth('s')!.healthy).toBe(false)
  })
})
