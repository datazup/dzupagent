import { describe, it, expect } from 'vitest'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveAgentTools, ToolResolutionError } from '../runtime/tool-resolver.js'

describe('tool-resolver', () => {
  it('resolves default git category into git tools when codegen is available', async () => {
    const result = await resolveAgentTools({ toolNames: ['git:*'] })

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
    const result = await resolveAgentTools({ toolNames: ['git_status', 'git_diff'] })

    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['git_diff', 'git_status'])
    expect(result.unresolved).toEqual([])
  })

  it('resolves connector:git category syntax', async () => {
    const result = await resolveAgentTools({ toolNames: ['connector:git'] })

    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.unresolved).not.toContain('connector:git')
  })

  it('returns empty result for empty toolNames', async () => {
    const result = await resolveAgentTools({ toolNames: [] })

    expect(result.tools).toEqual([])
    expect(result.activated).toEqual([])
    expect(result.unresolved).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('returns empty result when no toolNames and no custom resolver', async () => {
    const result = await resolveAgentTools({})

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
    const result = await resolveAgentTools({
      toolNames: ['github_get_file'],
      metadata: {},
      env: {},
    })

    expect(result.unresolved).toContain('github_get_file')
    expect(result.warnings.some((w) => w.includes('GitHub tools requested'))).toBe(true)
  })

  it('resolves connector:github category syntax and warns on missing token', async () => {
    const result = await resolveAgentTools({
      toolNames: ['connector:github'],
      metadata: {},
      env: {},
    })

    expect(result.warnings.some((w) =>
      w.includes('GitHub tools requested') || w.includes('Connector tools requested'),
    )).toBe(true)
  })

  it('does not attempt connector resolution when only git tools requested', async () => {
    const result = await resolveAgentTools({
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
      const result = await resolveAgentTools({
        toolNames: ['mcp:*'],
        metadata: {},
      })

      expect(result.warnings.some((w) => w.includes('no servers configured'))).toBe(true)
      expect(result.unresolved).not.toContain('mcp:*')
    })

    it('resolves mcp category tokens and removes them from unresolved', async () => {
      const result = await resolveAgentTools({
        toolNames: ['mcp:my-server'],
        metadata: {
          mcpServers: [
            { id: 'my-server', url: 'http://localhost:9999', transport: 'http' },
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
      const result = await resolveAgentTools({
        toolNames: ['mcp:*'],
        metadata: {
          mcpServers: [
            { id: 'test', url: 'http://localhost:9999', transport: 'http', timeoutMs: 100 },
          ],
        },
      })

      expect(typeof result.cleanup).toBe('function')
      // Should not throw on cleanup
      await result.cleanup?.()
    })

    it('skips mcp resolution when no mcp: patterns in requested tools', async () => {
      const result = await resolveAgentTools({
        toolNames: ['git:*'],
        metadata: {
          mcpServers: [
            { id: 'test', url: 'http://localhost:9999', transport: 'http' },
          ],
        },
      })

      // No MCP-related warnings
      expect(result.warnings.some((w) => w.includes('MCP'))).toBe(false)
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
