import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as MemoryIpcNs from '@dzupagent/memory-ipc'

const MEMORY_IPC_MODULE_PATH = '../memory-ipc.js'

async function loadMemoryIpcModule() {
  return import(MEMORY_IPC_MODULE_PATH)
}

function createModuleNotFoundError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' })
}

afterEach(() => {
  vi.doUnmock('@dzupagent/memory-ipc')
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('memory-ipc boundary', () => {
  it('loads the core memory-ipc subpath when the peer dependency is installed', async () => {
    const mod = await loadMemoryIpcModule()

    expect(mod.isMemoryIpcAvailable()).toBe(true)
    expect(mod.MEMORY_FRAME_VERSION).toBeDefined()
    expect(typeof mod.FrameBuilder).toBe('function')
    expect(typeof mod.FrameReader).toBe('function')
    expect(typeof mod.serializeToIPC).toBe('function')
    expect(typeof mod.handleExportMemory).toBe('function')
  })

  it('degrades gracefully when the peer dependency is missing', async () => {
    vi.doMock('@dzupagent/memory-ipc', async (importOriginal) => {
      const actual = await importOriginal<typeof MemoryIpcNs>()
      return {
        ...actual,
        get FrameBuilder() {
          throw createModuleNotFoundError(
            "Cannot find module '@dzupagent/memory-ipc' imported from /tmp/mock-memory-ipc.ts",
          )
        },
      }
    })

    const mod = await loadMemoryIpcModule()
    expect(mod.isMemoryIpcAvailable()).toBe(false)
    expect(mod.FrameBuilder).toBeUndefined()
    expect(mod.MEMORY_FRAME_VERSION).toBeUndefined()

    // getMemoryIpc() throws a clear error
    expect(() => mod.getMemoryIpc()).toThrow('yarn add @dzupagent/memory-ipc')
  })

  it('does not remap transitive ERR_MODULE_NOT_FOUND failures from other packages', async () => {
    vi.doMock('@dzupagent/memory-ipc', async (importOriginal) => {
      const actual = await importOriginal<typeof MemoryIpcNs>()
      return {
        ...actual,
        get MEMORY_FRAME_VERSION() {
          throw createModuleNotFoundError(
            "Cannot find module 'apache-arrow' imported from /tmp/mock-memory-ipc.ts",
          )
        },
      }
    })

    await expect(loadMemoryIpcModule()).rejects.toMatchObject({
      code: 'ERR_MODULE_NOT_FOUND',
      message: expect.stringContaining('apache-arrow'),
    })
  })

  it('degrades gracefully when the peer dependency exports are incomplete', async () => {
    vi.doMock('@dzupagent/memory-ipc', async (importOriginal) => {
      const actual = await importOriginal<typeof MemoryIpcNs>()
      return {
        ...actual,
        FrameReader: undefined,
      }
    })

    const mod = await loadMemoryIpcModule()
    expect(mod.isMemoryIpcAvailable()).toBe(false)
    expect(mod.FrameReader).toBeUndefined()
  })
})
