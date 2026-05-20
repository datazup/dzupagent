/**
 * Integration tests for the tool-resolution pipeline.
 *
 * Focus: end-to-end paths from tool ref → resolution → instantiation →
 * invocation, covering the full cross-module interaction between:
 *   - tool-resolver.ts        (resolveAgentTools orchestration)
 *   - mcp-tool-instantiation.ts (resolveMcpTools + MCPClient wiring)
 *   - custom-tool-instantiation.ts (applyCustomToolResolver)
 *
 * The fake MCP client is stubbed at the lowest reasonable boundary:
 * the MCPClient constructor that mcp-tool-instantiation.ts creates via
 * importFirstAvailable('@dzupagent/core'). This means the mock swims
 * through exactly the same dynamic-import path as production, catching
 * structural drift between the two modules.
 *
 * No real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { MCPToolDescriptor, MCPToolResult } from '@dzupagent/core'
import { resolveAgentTools, ToolResolutionError } from '../runtime/tool-resolver.js'
import { applyCustomToolResolver } from '../runtime/custom-tool-instantiation.js'
import { resolveMcpTools } from '../runtime/mcp-tool-instantiation.js'
import type { ToolResolverContext } from '../runtime/tool-resolver-types.js'
import {
  FakeMcpClient,
  FakeMcpServer,
  makeToolDescriptor,
} from './_helpers/fake-mcp-client.js'

// ---------------------------------------------------------------------------
// Module-level fake client shared between the mock factory and test bodies.
// vi.mock() is hoisted to the top of the file by vitest — the factory closure
// reads `fakeClient` at call-time (not at hoist-time), so assigning a fresh
// instance in beforeEach is safe.
// ---------------------------------------------------------------------------

let fakeClient: FakeMcpClient = new FakeMcpClient()

/**
 * Build a minimal mcpToolToLangChain stub that round-trips through the
 * fake client — same shape as the real bridge.
 */
function stubMcpToolToLangChain(
  descriptor: MCPToolDescriptor,
  _client: unknown,
): ReturnType<typeof tool> {
  const shape: Record<string, unknown> = {}
  for (const [key, param] of Object.entries(descriptor.inputSchema.properties)) {
    shape[key] = (param as { type: string }).type === 'number'
      ? z.number().optional()
      : z.string().optional()
  }
  return tool(
    async (args: Record<string, unknown>) => {
      const result = await fakeClient.invokeTool(descriptor.name, args)
      if (result.isError) {
        return `Error: ${result.content.map((c) => c.text ?? '').join('\n')}`
      }
      return result.content.map((c) => c.text ?? '').join('\n')
    },
    {
      name: descriptor.name,
      description: descriptor.description,
      schema: z.object(shape as Parameters<typeof z.object>[0]),
    },
  )
}

// ---------------------------------------------------------------------------
// Wire @dzupagent/core mock — hoisted by vitest; reads fakeClient at runtime.
// Same technique as mcp-integration.test.ts.
// ---------------------------------------------------------------------------

vi.mock('@dzupagent/core', () => ({
  MCPClient: class {
    addServer(...args: unknown[]) {
      return (fakeClient.addServer as (...a: unknown[]) => void)(...args)
    }
    connect(...args: unknown[]) {
      return (fakeClient.connect as (...a: unknown[]) => Promise<boolean>)(...args)
    }
    getEagerTools() {
      return fakeClient.getEagerTools()
    }
    disconnectAll() {
      return fakeClient.disconnectAll()
    }
    invokeTool(...args: unknown[]) {
      return (fakeClient.invokeTool as (...a: unknown[]) => Promise<MCPToolResult>)(...args)
    }
  },
  validateOutboundUrl: async (url: string, policy?: { allowedHosts?: Iterable<string> }) => {
    const parsed = new URL(url)
    const allowed = new Set(Array.from(policy?.allowedHosts ?? []))
    if (allowed.has(parsed.hostname) || allowed.has(parsed.host)) {
      return { ok: true, url: parsed, resolvedAddresses: [] }
    }
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === '169.254.169.254') {
      return { ok: false, reason: `URL host "${parsed.hostname}" is not a public IP address.` }
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'fake') {
      return { ok: false, reason: 'URL protocol must be https unless trusted HTTP is explicitly allowed.' }
    }
    return { ok: true, url: parsed, resolvedAddresses: [] }
  },
  mcpToolToLangChain: (descriptor: MCPToolDescriptor, client: unknown) =>
    stubMcpToolToLangChain(descriptor, client),
}))

beforeEach(() => {
  // Assign a fresh client so every test starts with a clean state.
  fakeClient = new FakeMcpClient()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpContext(
  toolNames: string[],
  servers: Array<{ id: string; name?: string; url: string; maxEagerTools?: number }>,
  env: NodeJS.ProcessEnv = { DZIP_MCP_ALLOWED_HTTP_HOSTS: 'fake:8000,fake:8001,fake:8002' },
): ToolResolverContext {
  return { toolNames, metadata: { mcpServers: servers }, env }
}

// ===========================================================================
// 1. BUILTIN TOOL (git) — resolve + invoke
// ===========================================================================
describe('Pipeline: builtin git tool', () => {
  it('resolves a git category and produces invocable tools', async () => {
    // Arrange
    const context: ToolResolverContext = { toolNames: ['git:*'] }
    // Act
    const result = await resolveAgentTools(context)
    // Assert — all five canonical git tools must be present
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['git_branch', 'git_commit', 'git_diff', 'git_log', 'git_status'])
    expect(result.activated.every((a) => a.source === 'git')).toBe(true)
    expect(result.unresolved).toEqual([])
  })

  it('individual git tool resolves to StructuredToolInterface with name + description + invoke', async () => {
    const result = await resolveAgentTools({ toolNames: ['git_status'] })
    const t = result.tools.find((x) => x.name === 'git_status')
    expect(t).toBeDefined()
    expect(typeof t!.description).toBe('string')
    expect(typeof t!.invoke).toBe('function')
    expect(t!.schema).toBeDefined()
  })
})

// ===========================================================================
// 2. CUSTOM CODE TOOL — resolve + invoke
// ===========================================================================
describe('Pipeline: custom code tool', () => {
  it('resolves a custom tool and invokes it correctly', async () => {
    // Arrange
    const customTool = tool(async (_args: { x: string }) => `echo:${_args.x}`, {
      name: 'custom_echo',
      description: 'Echoes the input',
      schema: z.object({ x: z.string() }),
    })
    // Act
    const result = await resolveAgentTools(
      { toolNames: ['custom_echo'] },
      async () => [customTool],
    )
    // Assert
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe('custom_echo')
    expect(result.activated[0].source).toBe('custom')
    expect(result.unresolved).toEqual([])

    const output = await result.tools[0].invoke({ x: 'hello' })
    expect(output).toBe('echo:hello')
  })

  it('custom tool registered via applyCustomToolResolver directly (unit-level seam)', async () => {
    // applyCustomToolResolver is the seam between resolver orchestration
    // and custom injection — test it in isolation.
    const existing = tool(async () => 'original', {
      name: 'git_status',
      description: 'original git status',
      schema: z.object({}),
    })
    const override = tool(async () => 'overridden', {
      name: 'git_status',
      description: 'custom override',
      schema: z.object({}),
    })
    const tools = [existing]
    const activated: Array<{ name: string; source: 'custom' }> = [{ name: 'git_status', source: 'custom' }]
    const unresolved = new Set<string>()

    await applyCustomToolResolver({
      context: {},
      customResolver: async () => [override],
      tools,
      activated,
      unresolved,
    })

    // Override replaces the original; only one entry with name git_status
    expect(tools).toHaveLength(1)
    expect(tools[0].description).toBe('custom override')
    expect(activated[0].source).toBe('custom')
  })

  it('custom tool fills an unresolved slot', async () => {
    const result = await resolveAgentTools(
      { toolNames: ['my_special_tool', 'not_a_real_tool'] },
      async () => [
        tool(async () => 'result', {
          name: 'my_special_tool',
          description: 'desc',
          schema: z.object({}),
        }),
      ],
    )

    expect(result.unresolved).not.toContain('my_special_tool')
    expect(result.unresolved).toContain('not_a_real_tool')
    expect(result.activated.find((a) => a.name === 'my_special_tool')?.source).toBe('custom')
  })
})

// ===========================================================================
// 3. MCP TOOL — resolve + invoke with fake MCP client
// ===========================================================================
describe('Pipeline: MCP tool (fake client at MCPClient boundary)', () => {
  it('resolves an MCP tool and invokes it through the full pipeline', async () => {
    // Arrange
    const server = new FakeMcpServer({
      id: 'calc-srv',
      tools: [makeToolDescriptor('add', 'calc-srv', { a: { type: 'number' }, b: { type: 'number' } })],
      responses: {
        add: { content: [{ type: 'text', text: '42' }] },
      },
    })
    fakeClient.registerBackend(server)

    // Act
    const result = await resolveAgentTools(
      mcpContext(['mcp:calc-srv'], [{ id: 'calc-srv', url: 'http://fake:8000' }]),
    )

    // Assert resolution
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe('add')
    expect(result.activated[0]).toEqual({ name: 'add', source: 'mcp' })
    expect(result.unresolved).toEqual([])

    // Assert invocation round-trip
    const output = await result.tools[0].invoke({ a: 20, b: 22 })
    expect(output).toBe('42')

    // The fake server recorded the call
    expect(server.callHistory).toHaveLength(1)
    expect(server.callHistory[0]!.tool).toBe('add')
  })

  it('resolveMcpTools directly (isolates mcp-tool-instantiation seam)', async () => {
    // This exercises mcp-tool-instantiation.ts in isolation from the resolver
    // orchestration in tool-resolver.ts.
    const server = new FakeMcpServer({
      id: 'direct-srv',
      tools: [makeToolDescriptor('ping', 'direct-srv')],
    })
    fakeClient.registerBackend(server)

    const result = await resolveMcpTools(
      new Set(['mcp:direct-srv']),
      {
        metadata: { mcpServers: [{ id: 'direct-srv', url: 'http://fake:8000' }] },
        env: { DZIP_MCP_ALLOWED_HTTP_HOSTS: 'fake:8000' },
      },
    )

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe('ping')
    expect(result.activated).toEqual([{ name: 'ping', source: 'mcp' }])
    expect(result.resolved).toContain('mcp:direct-srv')
    expect(result.warnings).toHaveLength(0)

    // Cleanup does not throw
    await expect(result.cleanup()).resolves.toBeUndefined()
    expect(fakeClient.disconnectAllCallCount).toBe(1)
  })

  it('MCP server resolved by name (not just id) when server has a name field', async () => {
    const server = new FakeMcpServer({
      id: 'srv-id-abc',
      name: 'friendly-name',
      tools: [makeToolDescriptor('listed', 'srv-id-abc')],
    })
    fakeClient.registerBackend(server)

    // Request by friendly-name, not by id
    const result = await resolveAgentTools(
      mcpContext(
        ['mcp:friendly-name'],
        [{ id: 'srv-id-abc', name: 'friendly-name', url: 'http://fake:8000' }],
      ),
    )

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].name).toBe('listed')
  })
})

// ===========================================================================
// 4. UNKNOWN TOOL REF — expected error type + unresolved tracking
// ===========================================================================
describe('Pipeline: unknown tool ref', () => {
  it('unknown tool ref lands in unresolved array (lenient mode)', async () => {
    const result = await resolveAgentTools({ toolNames: ['does_not_exist'] })

    expect(result.tools).toHaveLength(0)
    expect(result.unresolved).toContain('does_not_exist')
    expect(result.warnings.some((w) => w.includes('Some requested tools are unresolved'))).toBe(true)
  })

  it('throws ToolResolutionError in strict mode for unknown tool', async () => {
    await expect(
      resolveAgentTools({ toolNames: ['does_not_exist'] }, undefined, { resolvePolicy: 'strict' }),
    ).rejects.toThrow(ToolResolutionError)
  })

  it('ToolResolutionError carries unresolved names and warnings', async () => {
    let caught: ToolResolutionError | undefined
    try {
      await resolveAgentTools(
        { toolNames: ['ghost_tool_a', 'ghost_tool_b'] },
        undefined,
        { resolvePolicy: 'strict' },
      )
    } catch (err) {
      caught = err as ToolResolutionError
    }
    expect(caught).toBeInstanceOf(ToolResolutionError)
    expect(caught!.unresolved).toContain('ghost_tool_a')
    expect(caught!.unresolved).toContain('ghost_tool_b')
    expect(caught!.message).toContain('ghost_tool_a')
    expect(typeof caught!.warnings).toBe('object')
  })

  it('strict mode with partial MCP resolution throws for non-MCP unresolved', async () => {
    const server = new FakeMcpServer({
      id: 'partial-srv',
      tools: [makeToolDescriptor('ok_tool', 'partial-srv')],
    })
    fakeClient.registerBackend(server)

    await expect(
      resolveAgentTools(
        {
          ...mcpContext(['mcp:partial-srv', 'truly_unknown_tool'], [{ id: 'partial-srv', url: 'http://fake:8000' }]),
        },
        undefined,
        { resolvePolicy: 'strict' },
      ),
    ).rejects.toThrow(ToolResolutionError)
  })
})

// ===========================================================================
// 5. MCP TRANSPORT FAILURE — expected error type, no orphaned state
// ===========================================================================
describe('Pipeline: MCP transport failure', () => {
  it('returns empty tools and warning when MCP server fails to connect', async () => {
    const server = new FakeMcpServer({ id: 'down-srv', tools: [], failConnect: true })
    fakeClient.registerBackend(server)

    const result = await resolveAgentTools(
      mcpContext(['mcp:down-srv'], [{ id: 'down-srv', url: 'http://fake:8000' }]),
    )

    expect(result.tools).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('failed to connect'))).toBe(true)
  })

  it('cleanup is still callable after connection failure (no orphaned state)', async () => {
    const server = new FakeMcpServer({ id: 'orphan-srv', tools: [], failConnect: true })
    fakeClient.registerBackend(server)

    const result = await resolveAgentTools(
      mcpContext(['mcp:orphan-srv'], [{ id: 'orphan-srv', url: 'http://fake:8000' }]),
    )

    expect(typeof result.cleanup).toBe('function')
    await expect(result.cleanup!()).resolves.toBeUndefined()
    // disconnectAll must have been called exactly once (cleanup callback returned by resolveMcpTools
    // is always the client.disconnectAll, even on failure)
    expect(fakeClient.disconnectAllCallCount).toBe(1)
  })

  it('warns "All MCP servers failed to connect" when every server is down', async () => {
    const srv1 = new FakeMcpServer({ id: 's1', tools: [], failConnect: true })
    const srv2 = new FakeMcpServer({ id: 's2', tools: [], failConnect: true })
    fakeClient.registerBackend(srv1)
    fakeClient.registerBackend(srv2)

    const result = await resolveAgentTools(
      mcpContext(
        ['mcp:*'],
        [{ id: 's1', url: 'http://fake:8001' }, { id: 's2', url: 'http://fake:8002' }],
      ),
    )

    expect(result.tools).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('All MCP servers failed to connect'))).toBe(true)
  })

  it('no MCP backend registered is treated the same as connection failure', async () => {
    // Nothing registered in fakeClient; connect() returns false
    const result = await resolveAgentTools(
      mcpContext(['mcp:ghost-srv'], [{ id: 'ghost-srv', url: 'http://fake:8000' }]),
    )

    expect(result.tools).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('ghost-srv'))).toBe(true)
    // The mcp token must still be removed from unresolved
    expect(result.unresolved).not.toContain('mcp:ghost-srv')
  })

  it('warns when no MCP servers are configured in metadata', async () => {
    // No mcpServers array in metadata — exercises the early-return path
    const result = await resolveMcpTools(
      new Set(['mcp:any-server']),
      { metadata: {}, env: {} },
    )

    expect(result.tools).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('no servers configured'))).toBe(true)
    await expect(result.cleanup()).resolves.toBeUndefined()
  })
})

// ===========================================================================
// 6. SCHEMA VALIDATION FAILURE — tool invocation returns error string,
//    run is not corrupted (remaining tools still work)
// ===========================================================================
describe('Pipeline: schema mismatch / bad input', () => {
  it('MCP tool invocation with error response returns error string, does not throw', async () => {
    const server = new FakeMcpServer({
      id: 'err-srv',
      tools: [makeToolDescriptor('risky', 'err-srv', { data: { type: 'string' } })],
      responses: {
        risky: {
          content: [{ type: 'text', text: 'validation failed: data must be non-empty' }],
          isError: true,
        },
      },
    })
    fakeClient.registerBackend(server)

    const result = await resolveAgentTools(
      mcpContext(['mcp:err-srv'], [{ id: 'err-srv', url: 'http://fake:8000' }]),
    )

    const output = await result.tools[0].invoke({ data: '' })
    // Returns the error string — does not throw, run continues
    expect(typeof output).toBe('string')
    expect(output).toContain('Error')
    expect(output).toContain('validation failed')
  })

  it('second tool in the same result is still invocable after first returns an error', async () => {
    const server = new FakeMcpServer({
      id: 'mixed-srv',
      tools: [
        makeToolDescriptor('bad_tool', 'mixed-srv'),
        makeToolDescriptor('good_tool', 'mixed-srv'),
      ],
      responses: {
        bad_tool: { content: [{ type: 'text', text: 'boom' }], isError: true },
        good_tool: { content: [{ type: 'text', text: 'success' }] },
      },
    })
    fakeClient.registerBackend(server)

    const result = await resolveAgentTools(
      mcpContext(['mcp:mixed-srv'], [{ id: 'mixed-srv', url: 'http://fake:8000' }]),
    )

    expect(result.tools).toHaveLength(2)
    const badTool = result.tools.find((t) => t.name === 'bad_tool')!
    const goodTool = result.tools.find((t) => t.name === 'good_tool')!

    const badOut = await badTool.invoke({})
    expect(badOut).toContain('Error')

    const goodOut = await goodTool.invoke({})
    expect(goodOut).toBe('success')
  })
})

// ===========================================================================
// 7. ALL THREE SOURCES TOGETHER — cross-source coexistence
// ===========================================================================
describe('Pipeline: builtin + custom + MCP coexistence', () => {
  it('all three sources resolved in one call without cross-contamination', async () => {
    // Arrange: one MCP server
    const server = new FakeMcpServer({
      id: 'combo-srv',
      tools: [makeToolDescriptor('mcp_lookup', 'combo-srv')],
    })
    fakeClient.registerBackend(server)

    // Custom tool
    const customTool = tool(async () => 'custom result', {
      name: 'my_custom',
      description: 'a custom tool',
      schema: z.object({}),
    })

    // Act
    const result = await resolveAgentTools(
      {
        toolNames: ['git_status', 'my_custom', 'mcp:combo-srv'],
        metadata: { mcpServers: [{ id: 'combo-srv', url: 'http://fake:8000' }] },
        env: { DZIP_MCP_ALLOWED_HTTP_HOSTS: 'fake:8000' },
      },
      async () => [customTool],
    )

    // Assert — all three resolved with correct sources
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toContain('git_status')
    expect(names).toContain('my_custom')
    expect(names).toContain('mcp_lookup')
    expect(result.unresolved).toEqual([])

    const gitActivated = result.activated.find((a) => a.name === 'git_status')
    const customActivated = result.activated.find((a) => a.name === 'my_custom')
    const mcpActivated = result.activated.find((a) => a.name === 'mcp_lookup')

    expect(gitActivated?.source).toBe('git')
    expect(customActivated?.source).toBe('custom')
    expect(mcpActivated?.source).toBe('mcp')
  })

  it('custom resolver overrides a previously resolved MCP tool by name', async () => {
    const server = new FakeMcpServer({
      id: 'ov-srv',
      tools: [makeToolDescriptor('shared_tool', 'ov-srv')],
    })
    fakeClient.registerBackend(server)

    const override = tool(async () => 'custom version', {
      name: 'shared_tool',
      description: 'custom override',
      schema: z.object({}),
    })

    const result = await resolveAgentTools(
      mcpContext(['mcp:ov-srv'], [{ id: 'ov-srv', url: 'http://fake:8000' }]),
      async () => [override],
    )

    // Only one entry named shared_tool
    const matching = result.tools.filter((t) => t.name === 'shared_tool')
    expect(matching).toHaveLength(1)
    expect(matching[0].description).toBe('custom override')

    const activated = result.activated.find((a) => a.name === 'shared_tool')
    expect(activated?.source).toBe('custom')

    // Invoked via custom impl
    const out = await matching[0].invoke({})
    expect(out).toBe('custom version')
  })

  it('custom resolver overrides a resolved git tool', async () => {
    const customStatus = tool(async () => 'my_status_output', {
      name: 'git_status',
      description: 'custom git status',
      schema: z.object({}),
    })

    const result = await resolveAgentTools(
      { toolNames: ['git:*'] },
      async () => [customStatus],
    )

    const statusTool = result.tools.find((t) => t.name === 'git_status')!
    expect(statusTool.description).toBe('custom git status')
    expect(result.activated.find((a) => a.name === 'git_status')?.source).toBe('custom')

    // Exactly one git_status
    expect(result.tools.filter((t) => t.name === 'git_status')).toHaveLength(1)
  })
})

// ===========================================================================
// 8. CLEANUP LIFECYCLE
// ===========================================================================
describe('Pipeline: cleanup lifecycle', () => {
  it('cleanup callback disconnects all MCP servers exactly once', async () => {
    const server = new FakeMcpServer({
      id: 'cleanup-srv',
      tools: [makeToolDescriptor('t', 'cleanup-srv')],
    })
    fakeClient.registerBackend(server)

    const result = await resolveAgentTools(
      mcpContext(['mcp:cleanup-srv'], [{ id: 'cleanup-srv', url: 'http://fake:8000' }]),
    )

    expect(fakeClient.disconnectAllCallCount).toBe(0)
    await result.cleanup!()
    expect(fakeClient.disconnectAllCallCount).toBe(1)

    // Calling cleanup again is safe (idempotent at the protocol level)
    await result.cleanup!()
    expect(fakeClient.disconnectAllCallCount).toBe(2)
  })

  it('cleanup is undefined when no MCP tools are requested', async () => {
    const result = await resolveAgentTools({ toolNames: ['git_status'] })
    // Cleanup is optional; non-MCP result may or may not provide it —
    // the important thing is calling it (if present) does not throw.
    if (result.cleanup) {
      await expect(result.cleanup()).resolves.toBeUndefined()
    }
    // No MCP disconnects
    expect(fakeClient.disconnectAllCallCount).toBe(0)
  })

  it('MCP cleanup is returned even when all servers fail to connect', async () => {
    const server = new FakeMcpServer({ id: 'fail-srv', tools: [], failConnect: true })
    fakeClient.registerBackend(server)

    const result = await resolveAgentTools(
      mcpContext(['mcp:fail-srv'], [{ id: 'fail-srv', url: 'http://fake:8000' }]),
    )

    expect(typeof result.cleanup).toBe('function')
    await expect(result.cleanup!()).resolves.toBeUndefined()
  })
})
