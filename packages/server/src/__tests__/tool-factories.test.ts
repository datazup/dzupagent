import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveConnectorFactory, resolveGitFactory } from '../runtime/tool-factories.js'
import { importFirstAvailable } from '../runtime/runtime-module-imports.js'

vi.mock('../runtime/runtime-module-imports.js', () => ({
  importFirstAvailable: vi.fn(),
}))

const importFirstAvailableMock = vi.mocked(importFirstAvailable)

describe('tool-factories', () => {
  beforeEach(() => {
    importFirstAvailableMock.mockReset()
  })

  it('resolves Git tools through the exported @dzupagent/codegen contract', async () => {
    class GitExecutor {}
    const createGitTools = vi.fn(() => [
      tool(
        async () => 'ok',
        {
          name: 'git_status',
          description: 'git status',
          schema: z.object({}),
        },
      ),
    ])
    importFirstAvailableMock.mockResolvedValueOnce({ createGitTools, GitExecutor })

    const result = await resolveGitFactory()

    expect(importFirstAvailableMock).toHaveBeenCalledTimes(1)
    expect(importFirstAvailableMock).toHaveBeenCalledWith(['@dzupagent/codegen'])
    expect(result).toEqual({ createGitTools, GitExecutor })
  })

  it('returns missing Git factories predictably when the package export is absent', async () => {
    importFirstAvailableMock.mockResolvedValueOnce(null)

    await expect(resolveGitFactory()).resolves.toEqual({
      createGitTools: null,
      GitExecutor: null,
    })
    expect(importFirstAvailableMock).toHaveBeenCalledWith(['@dzupagent/codegen'])
  })

  it('does not accept partial Git package exports', async () => {
    const createGitTools = vi.fn(() => [])
    importFirstAvailableMock.mockResolvedValueOnce({ createGitTools })

    await expect(resolveGitFactory()).resolves.toEqual({
      createGitTools: null,
      GitExecutor: null,
    })
  })

  it('resolves connectors through the exported @dzupagent/connectors contract', async () => {
    const connectors = {
      createGitHubConnector: vi.fn(() => []),
      createSlackConnector: vi.fn(() => []),
      createHTTPConnector: vi.fn(() => []),
    }
    importFirstAvailableMock.mockResolvedValueOnce(connectors)

    await expect(resolveConnectorFactory()).resolves.toBe(connectors)
    expect(importFirstAvailableMock).toHaveBeenCalledTimes(1)
    expect(importFirstAvailableMock).toHaveBeenCalledWith(['@dzupagent/connectors'])
  })

  it('returns null when optional connector factories are not installed', async () => {
    importFirstAvailableMock.mockResolvedValueOnce(null)

    await expect(resolveConnectorFactory()).resolves.toBeNull()
    expect(importFirstAvailableMock).toHaveBeenCalledWith(['@dzupagent/connectors'])
  })
})
