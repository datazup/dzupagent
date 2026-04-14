import { describe, expect, it } from 'vitest'

const MEMORY_IPC_MODULE_PATH = '../memory-ipc.js'

describe('Memory IPC availability guard', () => {
  it('isMemoryIpcAvailable returns a boolean', async () => {
    const mod = await import(MEMORY_IPC_MODULE_PATH)
    expect(typeof mod.isMemoryIpcAvailable()).toBe('boolean')
  })

  it('isMemoryIpcAvailable returns true when the peer dependency is installed', async () => {
    const mod = await import(MEMORY_IPC_MODULE_PATH)
    // In the test environment the peer dep is available
    expect(mod.isMemoryIpcAvailable()).toBe(true)
  })

  it('getMemoryIpc returns the module when available', async () => {
    const mod = await import(MEMORY_IPC_MODULE_PATH)
    if (mod.isMemoryIpcAvailable()) {
      const ipc = mod.getMemoryIpc()
      expect(ipc).toBeDefined()
      expect(typeof ipc.FrameBuilder).toBe('function')
    }
  })

  it('exports are defined when the peer dependency is available', async () => {
    const mod = await import(MEMORY_IPC_MODULE_PATH)
    if (mod.isMemoryIpcAvailable()) {
      expect(mod.MEMORY_FRAME_VERSION).toBeDefined()
      expect(mod.FrameBuilder).toBeDefined()
      expect(mod.serializeToIPC).toBeDefined()
    }
  })
})
