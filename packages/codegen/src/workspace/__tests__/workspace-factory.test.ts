import { describe, expect, it, vi } from 'vitest'

import type { SandboxProtocol } from '../../sandbox/sandbox-protocol.js'
import { LocalWorkspace } from '../local-workspace.js'
import { SandboxedWorkspace } from '../sandboxed-workspace.js'
import type { WorkspaceOptions } from '../types.js'
import { WorkspaceConfigurationError, WorkspaceFactory } from '../workspace-factory.js'

function createMockSandbox(): SandboxProtocol {
  return {
    execute: vi.fn<SandboxProtocol['execute']>().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }),
    uploadFiles: vi.fn<SandboxProtocol['uploadFiles']>().mockResolvedValue(undefined),
    downloadFiles: vi.fn<SandboxProtocol['downloadFiles']>().mockResolvedValue({}),
    cleanup: vi.fn<SandboxProtocol['cleanup']>().mockResolvedValue(undefined),
    isAvailable: vi.fn<SandboxProtocol['isAvailable']>().mockResolvedValue(true),
  }
}

function workspaceOptions(overrides: Partial<WorkspaceOptions> = {}): WorkspaceOptions {
  return {
    rootDir: '/tmp/dzupagent-workspace-factory-test',
    search: { provider: 'builtin' },
    command: {
      allowedCommands: ['echo'],
      timeoutMs: 5_000,
    },
    ...overrides,
  }
}

describe('WorkspaceFactory', () => {
  it('creates a SandboxedWorkspace when sandboxing is enabled and a backend is supplied', () => {
    const workspace = WorkspaceFactory.create(
      workspaceOptions({ sandbox: { enabled: true } }),
      createMockSandbox(),
    )

    expect(workspace).toBeInstanceOf(SandboxedWorkspace)
  })

  it('fails closed when sandboxing is enabled without a backend', () => {
    expect(() => WorkspaceFactory.create(
      workspaceOptions({ sandbox: { enabled: true } }),
    )).toThrow(WorkspaceConfigurationError)

    expect(() => WorkspaceFactory.create(
      workspaceOptions({ sandbox: { enabled: true } }),
    )).toThrow('Sandbox-enabled codegen requires a sandbox backend')
  })

  it('uses local execution only when sandbox local fallback is explicitly enabled', () => {
    const workspace = WorkspaceFactory.create(
      workspaceOptions({ sandbox: { enabled: true, allowLocalFallback: true } }),
    )

    expect(workspace).toBeInstanceOf(LocalWorkspace)
  })

  it('creates a LocalWorkspace when sandboxing is disabled', () => {
    const workspace = WorkspaceFactory.create(
      workspaceOptions({ sandbox: { enabled: false } }),
    )

    expect(workspace).toBeInstanceOf(LocalWorkspace)
  })
})
