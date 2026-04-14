import { describe, it, expect } from 'vitest'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveAgentTools, ToolResolutionError, getToolProfileConfig } from '../runtime/tool-resolver.js'
import type { ToolProfile, ToolResolverContext, ToolResolverResult } from '../runtime/tool-resolver.js'

const fastFailMcpServer = {
  id: 'test',
  url: 'http://localhost:9999',
  transport: 'http' as const,
  timeoutMs: 100,
}

const resolverCache = new Map<string, Promise<ToolResolverResult>>()

function resolveCached(context: ToolResolverContext): Promise<ToolResolverResult> {
  const key = JSON.stringify(context)
  const cached = resolverCache.get(key)
  if (cached) return cached
  const pending = resolveAgentTools(context)
  resolverCache.set(key, pending)
  return pending
}

describe('tool-resolver', { timeout: 30_000 }, () => {
  it('resolves default git category into git tools when codegen is available', async () => {
    const result = await resolveCached({ toolNames: ['git:*'] })

    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'git_branch',
      'git_commit',
      'git_diff',
      'git_log',
      'git_status',
    ])
    expect(result.unresolved).toEqual([])
  })

  it('resolves individual git tool names without wildcard', async () => {
    const result = await resolveCached({ toolNames: ['git_status', 'git_diff'] })

    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['git_diff', 'git_status'])
    expect(result.unresolved).toEqual([])
  })

  it('resolves connector:git category syntax', async () => {
    const result = await resolveCached({ toolNames: ['connector:git'] })

    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.unresolved).not.toContain('connector:git')
  })

  it('returns empty result for empty toolNames', async () => {
    const result = await resolveCached({ toolNames: [] })

    expect(result.tools).toEqual([])
    expect(result.activated).toEqual([])
    expect(result.unresolved).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('returns empty result when no toolNames and no custom resolver', async () => {
    const result = await resolveCached({})

    expect(result.tools).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('accepts custom resolver tools and marks them resolved', async () => {
    const result = await resolveAgentTools(
      { toolNames: ['custom_echo', 'unknown_tool'] },
      async () => [
        tool(
          async () => 'ok',
          {
            name: 'custom_echo',
            description: 'custom echo',
            schema: z.object({}),
          },
        ),
      ],
    )

    expect(result.tools.map((t) => t.name)).toContain('custom_echo')
    expect(result.unresolved).toContain('unknown_tool')
    expect(result.unresolved).not.toContain('custom_echo')
  })

  it('custom resolver overrides built-in tools with the same name', async () => {
    const customGitStatus = tool(
      async () => 'custom-git-status',
      {
        name: 'git_status',
        description: 'custom git status override',
        schema: z.object({}),
      },
    )

    const result = await resolveAgentTools(
      { toolNames: ['git:*'] },
      async () => [customGitStatus],
    )

    const gitStatusTool = result.tools.find((t) => t.name === 'git_status')
    expect(gitStatusTool).toBeDefined()
    expect(gitStatusTool!.description).toBe('custom git status override')

    const gitStatusActivated = result.activated.find((a) => a.name === 'git_status')
    expect(gitStatusActivated?.source).toBe('custom')

    // No duplicate git_status entries
    const gitStatusCount = result.tools.filter((t) => t.name === 'git_status').length
    expect(gitStatusCount).toBe(1)
  })

  it('returns warnings when requested connector prerequisites are missing', async () => {
    const result = await resolveCached({
      toolNames: ['github_get_file'],
      metadata: {},
      env: {},
    })

    expect(result.unresolved).toContain('github_get_file')
    expect(result.warnings.some((w) => w.includes('GitHub tools requested'))).toBe(true)
  })

  it('resolves connector:github category syntax and warns on missing token', async () => {
    const result = await resolveCached({
      toolNames: ['connector:github'],
      metadata: {},
      env: {},
    })

    expect(result.warnings.some((w) =>
      w.includes('GitHub tools requested') || w.includes('Connector tools requested'),
    )).toBe(true)
  })

  it('does not attempt connector resolution when only git tools requested', async () => {
    const result = await resolveCached({
      toolNames: ['git:*'],
      metadata: {},
      env: {},
    })

    // Should have no connector-related warnings
    expect(result.warnings.some((w) => w.includes('Connector tools requested'))).toBe(false)
    expect(result.warnings.some((w) => w.includes('GitHub tools requested'))).toBe(false)
  })

  describe('mcp resolver', () => {
    it('warns when mcp:* requested but no servers configured', async () => {
      const result = await resolveCached({
        toolNames: ['mcp:*'],
        metadata: {},
      })

      expect(result.warnings.some((w) => w.includes('no servers configured'))).toBe(true)
      expect(result.unresolved).not.toContain('mcp:*')
    })

    it('resolves mcp category tokens and removes them from unresolved', async () => {
      const result = await resolveCached({
        toolNames: ['mcp:my-server'],
        metadata: {
          mcpServers: [
            { ...fastFailMcpServer, id: 'my-server' },
          ],
        },
      })

      // Server won't actually connect (no real server), but the mcp: token
      // should still be removed from unresolved
      expect(result.unresolved).not.toContain('mcp:my-server')
      // Should get a connection failure warning
      expect(result.warnings.some((w) => w.includes('failed to connect'))).toBe(true)
    })

    it('returns cleanup function even on connection failure', async () => {
      const result = await resolveCached({
        toolNames: ['mcp:*'],
        metadata: {
          mcpServers: [
            fastFailMcpServer,
          ],
        },
      })

      expect(typeof result.cleanup).toBe('function')
      // Should not throw on cleanup
      await result.cleanup?.()
    })

    it('skips mcp resolution when no mcp: patterns in requested tools', async () => {
      const result = await resolveCached({
        toolNames: ['git:*'],
        metadata: {
          mcpServers: [
            fastFailMcpServer,
          ],
        },
      })

      // No MCP-related warnings
      expect(result.warnings.some((w) => w.includes('MCP'))).toBe(false)
    })

    it('blocks stdio transport from request metadata by default', async () => {
      const result = await resolveAgentTools({
        toolNames: ['mcp:local-stdio'],
        metadata: {
          mcpServers: [
            { id: 'local-stdio', url: 'echo', transport: 'stdio' },
          ],
        },
        env: {},
      })

      expect(result.unresolved).not.toContain('mcp:local-stdio')
      expect(result.warnings.some((w) => w.includes('metadata-defined stdio transport is disabled'))).toBe(true)
      expect(result.warnings.some((w) => w.includes('no servers configured'))).toBe(true)
    })

    it('enforces MCP HTTP host allowlist from environment', async () => {
      const result = await resolveAgentTools({
        toolNames: ['mcp:my-server'],
        metadata: {
          mcpServers: [
            { ...fastFailMcpServer, id: 'my-server', url: 'http://blocked.example:8000' },
          ],
        },
        env: {
          DZIP_MCP_ALLOWED_HTTP_HOSTS: 'localhost:9999',
        },
      })

      expect(result.unresolved).not.toContain('mcp:my-server')
      expect(result.warnings.some((w) => w.includes('not in DZIP_MCP_ALLOWED_HTTP_HOSTS'))).toBe(true)
      expect(result.warnings.some((w) => w.includes('no servers configured'))).toBe(true)
    })
  })

  describe('tool profiles', () => {
    it('getToolProfileConfig returns correct config for each profile', () => {
      const defaultCfg = getToolProfileConfig('default')
      expect(defaultCfg.enabledCategories).toEqual(['git'])
      expect(defaultCfg.enableMcp).toBe(false)
      expect(defaultCfg.enableConnectors).toBe(false)

      const codegenCfg = getToolProfileConfig('codegen')
      expect(codegenCfg.enabledCategories).toEqual(['git', 'github'])
      expect(codegenCfg.enableMcp).toBe(false)

      const gitCfg = getToolProfileConfig('git')
      expect(gitCfg.enabledCategories).toEqual(['git', 'github'])
      expect(gitCfg.enableMcp).toBe(false)

      const connectorsCfg = getToolProfileConfig('connectors')
      expect(connectorsCfg.enabledCategories).toContain('git')
      expect(connectorsCfg.enabledCategories).toContain('slack')
      expect(connectorsCfg.enabledCategories).toContain('http')
      expect(connectorsCfg.enableMcp).toBe(false)
      expect(connectorsCfg.enableConnectors).toBe(true)

      const fullCfg = getToolProfileConfig('full')
      expect(fullCfg.enabledCategories).toContain('git')
      expect(fullCfg.enabledCategories).toContain('github')
      expect(fullCfg.enabledCategories).toContain('slack')
      expect(fullCfg.enabledCategories).toContain('http')
      expect(fullCfg.enableMcp).toBe(true)
      expect(fullCfg.enableConnectors).toBe(true)
    })

    it('default profile resolves git tools only', async () => {
      const result = await resolveCached({ toolProfile: 'default' })

      const names = result.tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'git_branch',
        'git_commit',
        'git_diff',
        'git_log',
        'git_status',
      ])
      // No connector warnings when connectors not requested
      expect(result.warnings.some((w) => w.includes('Connector tools requested'))).toBe(false)
    })

    it('codegen profile resolves git and github categories', async () => {
      const result = await resolveCached({
        toolProfile: 'codegen',
        metadata: {},
        env: {},
      })

      // Git tools should be resolved
      const gitTools = result.activated.filter((a) => a.source === 'git')
      expect(gitTools.length).toBeGreaterThan(0)
      // GitHub tools should be attempted (will warn about missing token)
      expect(result.warnings.some((w) =>
        w.includes('GitHub tools requested') || w.includes('Connector tools requested'),
      )).toBe(true)
    })

    it('full profile enables mcp category', async () => {
      const result = await resolveAgentTools({
        toolProfile: 'full',
        metadata: {},
        env: {},
      })

      // MCP was attempted (will warn about no servers configured)
      expect(result.warnings.some((w) => w.includes('no servers configured'))).toBe(true)
      // Git tools should still be resolved
      const gitTools = result.activated.filter((a) => a.source === 'git')
      expect(gitTools.length).toBeGreaterThan(0)
    })

    it('explicit tool names override profile restrictions', async () => {
      // 'default' profile only enables git, but explicit 'github_get_file' should still be attempted
      const result = await resolveAgentTools({
        toolProfile: 'default',
        toolNames: ['github_get_file'],
        metadata: {},
        env: {},
      })

      // github_get_file was attempted — should warn about missing token or connector
      expect(result.warnings.some((w) =>
        w.includes('GitHub tools requested') || w.includes('Connector tools requested'),
      )).toBe(true)
    })

    it('profile categories merge with explicit toolNames', async () => {
      const result = await resolveAgentTools({
        toolProfile: 'default',
        toolNames: ['git_status'],
      })

      // Profile expands 'git:*', plus explicit 'git_status' — all git tools should resolve
      const names = result.tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'git_branch',
        'git_commit',
        'git_diff',
        'git_log',
        'git_status',
      ])
    })

    it('no profile and no toolNames returns empty result', async () => {
      const result = await resolveAgentTools({})
      expect(result.tools).toEqual([])
      expect(result.activated).toEqual([])
    })
  })

  describe('strict resolve policy', () => {
    it('throws ToolResolutionError when unresolved tools remain in strict mode', async () => {
      await expect(
        resolveAgentTools(
          { toolNames: ['nonexistent_tool'] },
          undefined,
          { resolvePolicy: 'strict' },
        ),
      ).rejects.toThrow(ToolResolutionError)
    })

    it('ToolResolutionError contains unresolved names and warnings', async () => {
      try {
        await resolveAgentTools(
          { toolNames: ['nonexistent_tool', 'another_missing'] },
          undefined,
          { resolvePolicy: 'strict' },
        )
        expect.fail('Expected ToolResolutionError')
      } catch (err) {
        expect(err).toBeInstanceOf(ToolResolutionError)
        const error = err as ToolResolutionError
        expect(error.unresolved).toContain('nonexistent_tool')
        expect(error.unresolved).toContain('another_missing')
        expect(error.message).toContain('nonexistent_tool')
      }
    })

    it('does not throw in strict mode when all tools are resolved', async () => {
      const result = await resolveAgentTools(
        { toolNames: ['git:*'] },
        undefined,
        { resolvePolicy: 'strict' },
      )

      expect(result.tools.length).toBeGreaterThan(0)
      expect(result.unresolved).toEqual([])
    })

    it('lenient mode (default) returns result even with unresolved tools', async () => {
      const result = await resolveAgentTools(
        { toolNames: ['nonexistent_tool'] },
        undefined,
        { resolvePolicy: 'lenient' },
      )

      expect(result.unresolved).toContain('nonexistent_tool')
      expect(result.warnings.length).toBeGreaterThan(0)
    })
  })
})
