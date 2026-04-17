/**
 * W15-D2: CLI Command Smoke Tests
 *
 * Smoke tests for all CLI command entry-points in @dzupagent/server.
 * Tests verify: correct exports/shape, basic invocation, flag parsing,
 * and error handling. Business logic is NOT deeply tested here.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// config-command
// ---------------------------------------------------------------------------

describe('CLI: config-command', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-cli-config-'))
  })

  it('exports configValidate and configShow functions', async () => {
    const mod = await import('../cli/config-command.js')
    expect(typeof mod.configValidate).toBe('function')
    expect(typeof mod.configShow).toBe('function')
  })

  it('configValidate returns valid for a correct config file', async () => {
    const { configValidate } = await import('../cli/config-command.js')
    const configPath = join(tempDir, 'config.json')
    await writeFile(configPath, JSON.stringify({ port: 4000 }), 'utf-8')

    const result = configValidate(configPath)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('configValidate returns error for missing file', async () => {
    const { configValidate } = await import('../cli/config-command.js')
    const result = configValidate('/nonexistent/path.json')

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Cannot read config file')
  })

  it('configValidate returns error for invalid JSON', async () => {
    const { configValidate } = await import('../cli/config-command.js')
    const configPath = join(tempDir, 'bad.json')
    await writeFile(configPath, 'not json {{{', 'utf-8')

    const result = configValidate(configPath)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('not valid JSON')
  })

  it('configValidate rejects invalid port', async () => {
    const { configValidate } = await import('../cli/config-command.js')
    const configPath = join(tempDir, 'config.json')
    await writeFile(configPath, JSON.stringify({ port: 99999 }), 'utf-8')

    const result = configValidate(configPath)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('port'))
  })

  it('configValidate rejects invalid rateLimit.maxRequests', async () => {
    const { configValidate } = await import('../cli/config-command.js')
    const configPath = join(tempDir, 'config.json')
    await writeFile(configPath, JSON.stringify({ rateLimit: { maxRequests: -1 } }), 'utf-8')

    const result = configValidate(configPath)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('maxRequests'))
  })

  it('configShow returns parsed config object', async () => {
    const { configShow } = await import('../cli/config-command.js')
    const configPath = join(tempDir, 'config.json')
    await writeFile(configPath, JSON.stringify({ port: 3000, auth: { mode: 'api-key' } }), 'utf-8')

    const result = configShow(configPath)
    expect(result).toEqual({ port: 3000, auth: { mode: 'api-key' } })
  })

  it('configShow returns empty object for missing file', async () => {
    const { configShow } = await import('../cli/config-command.js')
    const result = configShow('/nonexistent/file.json')
    expect(result).toEqual({})
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })
})

// ---------------------------------------------------------------------------
// dev-command
// ---------------------------------------------------------------------------

describe('CLI: dev-command', () => {
  it('exports createDevCommand function', async () => {
    const mod = await import('../cli/dev-command.js')
    expect(typeof mod.createDevCommand).toBe('function')
  })

  it('createDevCommand returns an object with start and stop methods', async () => {
    const { createDevCommand } = await import('../cli/dev-command.js')
    const handle = createDevCommand({ port: 5555 })

    expect(typeof handle.start).toBe('function')
    expect(typeof handle.stop).toBe('function')
  })

  it('start and stop lifecycle completes without error', async () => {
    const { createDevCommand } = await import('../cli/dev-command.js')
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const handle = createDevCommand({ port: 5555, verbose: false })
    await handle.start()
    await handle.stop()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Starting dev server'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Server stopped'))
    consoleSpy.mockRestore()
  })

  it('respects noPlayground option', async () => {
    const { createDevCommand } = await import('../cli/dev-command.js')
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const handle = createDevCommand({ port: 5556, noPlayground: true })
    await handle.start()
    await handle.stop()

    const playgroundCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Playground'),
    )
    expect(playgroundCalls).toHaveLength(0)
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// marketplace-command
// ---------------------------------------------------------------------------

describe('CLI: marketplace-command', () => {
  it('exports searchMarketplace, filterByCategory, formatPluginTable, createSampleRegistry', async () => {
    const mod = await import('../cli/marketplace-command.js')
    expect(typeof mod.searchMarketplace).toBe('function')
    expect(typeof mod.filterByCategory).toBe('function')
    expect(typeof mod.formatPluginTable).toBe('function')
    expect(typeof mod.createSampleRegistry).toBe('function')
  })

  it('createSampleRegistry returns registry with plugins and categories', async () => {
    const { createSampleRegistry } = await import('../cli/marketplace-command.js')
    const registry = createSampleRegistry()

    expect(registry.plugins.length).toBeGreaterThan(0)
    expect(registry.categories.length).toBeGreaterThan(0)
    expect(registry.lastUpdated).toBeTruthy()
  })

  it('searchMarketplace finds plugins by name', async () => {
    const { createSampleRegistry, searchMarketplace } = await import('../cli/marketplace-command.js')
    const registry = createSampleRegistry()

    const results = searchMarketplace(registry, 'otel')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toContain('otel')
  })

  it('searchMarketplace returns empty for no match', async () => {
    const { createSampleRegistry, searchMarketplace } = await import('../cli/marketplace-command.js')
    const registry = createSampleRegistry()

    const results = searchMarketplace(registry, 'zzzznonexistent')
    expect(results).toEqual([])
  })

  it('filterByCategory returns only plugins in the requested category', async () => {
    const { createSampleRegistry, filterByCategory } = await import('../cli/marketplace-command.js')
    const registry = createSampleRegistry()

    const results = filterByCategory(registry, 'security')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((p) => p.category === 'security')).toBe(true)
  })

  it('formatPluginTable returns "No plugins found." for empty list', async () => {
    const { formatPluginTable } = await import('../cli/marketplace-command.js')
    const output = formatPluginTable([])
    expect(output).toBe('No plugins found.')
  })

  it('formatPluginTable produces a table with headers for non-empty list', async () => {
    const { createSampleRegistry, formatPluginTable } = await import('../cli/marketplace-command.js')
    const registry = createSampleRegistry()

    const output = formatPluginTable(registry.plugins.slice(0, 2))
    expect(output).toContain('Name')
    expect(output).toContain('Version')
    expect(output).toContain('Category')
  })
})

// ---------------------------------------------------------------------------
// mcp-command
// ---------------------------------------------------------------------------

describe('CLI: mcp-command', () => {
  // Minimal mock McpManager
  function createMockMcpManager(overrides: Record<string, unknown> = {}) {
    return {
      listServers: vi.fn().mockResolvedValue(overrides['servers'] ?? []),
      addServer: vi.fn().mockResolvedValue({ id: 'srv-1', name: 'test', enabled: true }),
      updateServer: vi.fn().mockResolvedValue({ id: 'srv-1', name: 'updated', enabled: true }),
      removeServer: vi.fn().mockResolvedValue(undefined),
      enableServer: vi.fn().mockResolvedValue({ id: 'srv-1', enabled: true }),
      disableServer: vi.fn().mockResolvedValue({ id: 'srv-1', enabled: false }),
      testServer: vi.fn().mockResolvedValue({ ok: true, toolCount: 5 }),
      addProfile: vi.fn().mockResolvedValue({ id: 'prof-1', serverIds: [], enabled: true }),
      removeProfile: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('exports all mcp functions and formatters', async () => {
    const mod = await import('../cli/mcp-command.js')
    expect(typeof mod.mcpList).toBe('function')
    expect(typeof mod.mcpAdd).toBe('function')
    expect(typeof mod.mcpUpdate).toBe('function')
    expect(typeof mod.mcpRemove).toBe('function')
    expect(typeof mod.mcpEnable).toBe('function')
    expect(typeof mod.mcpDisable).toBe('function')
    expect(typeof mod.mcpTest).toBe('function')
    expect(typeof mod.mcpBind).toBe('function')
    expect(typeof mod.mcpUnbind).toBe('function')
    expect(typeof mod.formatServerList).toBe('function')
    expect(typeof mod.formatTestResult).toBe('function')
    expect(typeof mod.formatProfileList).toBe('function')
  })

  it('mcpList returns success with server data', async () => {
    const { mcpList } = await import('../cli/mcp-command.js')
    const manager = createMockMcpManager({
      servers: [{ id: 's1', name: 'test', enabled: true }],
    })

    const result = await mcpList(manager as never)
    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(1)
  })

  it('mcpList returns error when manager throws', async () => {
    const { mcpList } = await import('../cli/mcp-command.js')
    const manager = createMockMcpManager()
    manager.listServers.mockRejectedValue(new Error('DB down'))

    const result = await mcpList(manager as never)
    expect(result.success).toBe(false)
    expect(result.error).toContain('DB down')
  })

  it('mcpAdd calls addServer with input', async () => {
    const { mcpAdd } = await import('../cli/mcp-command.js')
    const manager = createMockMcpManager()
    const input = { name: 'new-server', transport: 'stdio' as const, command: 'node' }

    const result = await mcpAdd(manager as never, input as never)
    expect(result.success).toBe(true)
    expect(manager.addServer).toHaveBeenCalledWith(input)
  })

  it('mcpRemove calls removeServer and returns success', async () => {
    const { mcpRemove } = await import('../cli/mcp-command.js')
    const manager = createMockMcpManager()

    const result = await mcpRemove(manager as never, 'srv-1')
    expect(result.success).toBe(true)
    expect(manager.removeServer).toHaveBeenCalledWith('srv-1')
  })

  it('mcpTest returns test result data', async () => {
    const { mcpTest } = await import('../cli/mcp-command.js')
    const manager = createMockMcpManager()

    const result = await mcpTest(manager as never, 'srv-1')
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ ok: true, toolCount: 5 })
  })

  it('formatServerList shows "No MCP servers" for empty list', async () => {
    const { formatServerList } = await import('../cli/mcp-command.js')
    expect(formatServerList([])).toBe('No MCP servers registered.')
  })

  it('formatTestResult shows success with tool count', async () => {
    const { formatTestResult } = await import('../cli/mcp-command.js')
    const output = formatTestResult('srv-1', { ok: true, toolCount: 3 })
    expect(output).toContain('reachable')
    expect(output).toContain('3 tools')
  })

  it('formatTestResult shows failure message', async () => {
    const { formatTestResult } = await import('../cli/mcp-command.js')
    const output = formatTestResult('srv-1', { ok: false, error: 'timeout' })
    expect(output).toContain('failed')
    expect(output).toContain('timeout')
  })
})

// ---------------------------------------------------------------------------
// memory-command
// ---------------------------------------------------------------------------

describe('CLI: memory-command', () => {
  function createMockMemoryService() {
    return {
      get: vi.fn().mockResolvedValue([
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ]),
      search: vi.fn().mockResolvedValue([
        { key: 'found1', score: 0.9 },
      ]),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('exports memoryBrowse and memorySearch', async () => {
    const mod = await import('../cli/memory-command.js')
    expect(typeof mod.memoryBrowse).toBe('function')
    expect(typeof mod.memorySearch).toBe('function')
  })

  it('memoryBrowse lists entries via get() when no search query', async () => {
    const { memoryBrowse } = await import('../cli/memory-command.js')
    const svc = createMockMemoryService()

    const result = await memoryBrowse(svc as never, {
      namespace: 'lessons',
      scope: { agent: 'a1' },
    })

    expect(result.length).toBe(2)
    expect(svc.get).toHaveBeenCalledWith('lessons', { agent: 'a1' })
  })

  it('memoryBrowse uses search() when search query is provided', async () => {
    const { memoryBrowse } = await import('../cli/memory-command.js')
    const svc = createMockMemoryService()

    const result = await memoryBrowse(svc as never, {
      namespace: 'lessons',
      scope: { agent: 'a1' },
      search: 'error handling',
      limit: 5,
    })

    expect(result.length).toBe(1)
    expect(svc.search).toHaveBeenCalledWith('lessons', { agent: 'a1' }, 'error handling', 5)
  })

  it('memorySearch aggregates across multiple namespaces', async () => {
    const { memorySearch } = await import('../cli/memory-command.js')
    const svc = createMockMemoryService()

    const results = await memorySearch(svc as never, 'query', { agent: 'a1' }, ['lessons', 'facts'])

    expect(svc.search).toHaveBeenCalledTimes(2)
    expect(results.length).toBeGreaterThan(0)
    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score)
    }
  })
})

// ---------------------------------------------------------------------------
// scorecard-command
// ---------------------------------------------------------------------------

describe('CLI: scorecard-command', () => {
  it('exports runScorecard and parseScorecardArgs', async () => {
    const mod = await import('../cli/scorecard-command.js')
    expect(typeof mod.runScorecard).toBe('function')
    expect(typeof mod.parseScorecardArgs).toBe('function')
  })

  it('parseScorecardArgs parses --json flag', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs(['--json'])
    expect(opts.format).toBe('json')
  })

  it('parseScorecardArgs parses --markdown flag', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs(['--markdown'])
    expect(opts.format).toBe('markdown')
  })

  it('parseScorecardArgs parses --md alias', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs(['--md'])
    expect(opts.format).toBe('markdown')
  })

  it('parseScorecardArgs parses --format console', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs(['--format', 'console'])
    expect(opts.format).toBe('console')
  })

  it('parseScorecardArgs parses --output flag', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs(['--output', '/tmp/report.txt'])
    expect(opts.output).toBe('/tmp/report.txt')
  })

  it('parseScorecardArgs parses -o alias for output', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs(['-o', '/tmp/report.json'])
    expect(opts.output).toBe('/tmp/report.json')
  })

  it('parseScorecardArgs returns empty options for no args', async () => {
    const { parseScorecardArgs } = await import('../cli/scorecard-command.js')
    const opts = parseScorecardArgs([])
    expect(opts.format).toBeUndefined()
    expect(opts.output).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// trace-printer
// ---------------------------------------------------------------------------

describe('CLI: trace-printer', () => {
  it('exports TracePrinter class', async () => {
    const mod = await import('../cli/trace-printer.js')
    expect(typeof mod.TracePrinter).toBe('function')
  })

  it('TracePrinter can be constructed with default (non-verbose) mode', async () => {
    const { TracePrinter } = await import('../cli/trace-printer.js')
    const printer = new TracePrinter()
    expect(printer).toBeDefined()
    expect(typeof printer.attach).toBe('function')
    expect(typeof printer.detach).toBe('function')
    expect(typeof printer.formatEvent).toBe('function')
  })

  it('formatEvent produces formatted string for agent:started event', async () => {
    const { TracePrinter } = await import('../cli/trace-printer.js')
    const printer = new TracePrinter(false)

    const event = {
      type: 'agent:started' as const,
      agentId: 'agent-1',
      runId: 'run-12345678-abcd',
    }

    const output = printer.formatEvent(event)
    expect(output).toContain('agent:started')
    expect(output).toContain('run-1234')
    expect(output).toContain('agent=agent-1')
  })

  it('formatEvent includes JSON data in verbose mode', async () => {
    const { TracePrinter } = await import('../cli/trace-printer.js')
    const printer = new TracePrinter(true)

    const event = {
      type: 'tool:called' as const,
      toolName: 'search',
      runId: 'run-abcdefgh-1234',
      agentId: 'a1',
      args: {},
    }

    const output = printer.formatEvent(event)
    expect(output).toContain('tool:called')
    expect(output).toContain('"toolName"')
    expect(output).toContain('"search"')
  })

  it('attach subscribes to event bus and detach unsubscribes', async () => {
    const { TracePrinter } = await import('../cli/trace-printer.js')
    const printer = new TracePrinter()

    const unsubscribe = vi.fn()
    const mockBus = {
      onAny: vi.fn().mockReturnValue(unsubscribe),
      emit: vi.fn(),
      on: vi.fn(),
    }

    printer.attach(mockBus as never)
    expect(mockBus.onAny).toHaveBeenCalledTimes(1)

    printer.detach()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('detach is safe to call multiple times', async () => {
    const { TracePrinter } = await import('../cli/trace-printer.js')
    const printer = new TracePrinter()

    // detach without attach should not throw
    expect(() => printer.detach()).not.toThrow()
    expect(() => printer.detach()).not.toThrow()
  })

  it('formatEvent uses [--------] when no runId is present', async () => {
    const { TracePrinter } = await import('../cli/trace-printer.js')
    const printer = new TracePrinter(false)

    const event = { type: 'budget:exceeded' as const, reason: 'Token limit' }
    const output = printer.formatEvent(event)
    expect(output).toContain('[--------]')
    expect(output).toContain('Token limit')
  })
})

// ---------------------------------------------------------------------------
// Additional edge case tests for already-covered commands
// (just to confirm exports and shape, no duplication of logic tests)
// ---------------------------------------------------------------------------

describe('CLI: doctor (export shape)', () => {
  it('exports runDoctor, formatDoctorReport, formatDoctorReportJSON', async () => {
    const mod = await import('../cli/doctor.js')
    expect(typeof mod.runDoctor).toBe('function')
    expect(typeof mod.formatDoctorReport).toBe('function')
    expect(typeof mod.formatDoctorReportJSON).toBe('function')
  })
})

describe('CLI: plugins-command (export shape)', () => {
  it('exports listPlugins, addPlugin, removePlugin', async () => {
    const mod = await import('../cli/plugins-command.js')
    expect(typeof mod.listPlugins).toBe('function')
    expect(typeof mod.addPlugin).toBe('function')
    expect(typeof mod.removePlugin).toBe('function')
  })
})

describe('CLI: vectordb-command (export shape)', () => {
  it('exports vectordbStatus and formatVectorDBStatus', async () => {
    const mod = await import('../cli/vectordb-command.js')
    expect(typeof mod.vectordbStatus).toBe('function')
    expect(typeof mod.formatVectorDBStatus).toBe('function')
  })
})
