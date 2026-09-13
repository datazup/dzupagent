import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('playwright')
  vi.resetModules()
})

describe('BrowserManager Playwright module interoperability', () => {
  it.each(['named', 'default'] as const)('starts a usable browser from %s exports', async (shape) => {
    const context = { browserContext: true }
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const chromium = { launch: vi.fn().mockResolvedValue(browser) }
    vi.doMock('playwright', () => shape === 'named'
      ? { chromium }
      : { chromium: undefined, default: { chromium } })

    const { BrowserManager } = await import('../browser/browser-manager.js')
    const manager = new BrowserManager()
    try {
      await manager.launch()
      await expect(manager.newContext()).resolves.toBe(context)
      expect(chromium.launch).toHaveBeenCalledWith({ headless: true })
    } finally {
      await manager.close()
    }
  })

  it('sanitizes launch failures, retains their cause, and allows a fresh launch', async () => {
    const cause = new Error('launch failed: https://user:password@example.test/private?token=secret')
    const context = { browserContext: true }
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const chromium = {
      launch: vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(browser),
    }
    vi.doMock('playwright', () => ({ chromium }))
    const { BrowserManager } = await import('../browser/browser-manager.js')
    const manager = new BrowserManager()

    const error = await manager.launch().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'BrowserLaunchError', message: 'BROWSER_LAUNCH_FAILED', cause })
    expect((error as Error).cause).toBe(cause)
    expect(String(error)).toBe('BrowserLaunchError: BROWSER_LAUNCH_FAILED')
    expect(JSON.stringify(error)).not.toContain('password')
    await expect(manager.newContext()).rejects.toThrow('Browser not launched')
    try {
      await manager.launch()
      await expect(manager.newContext()).resolves.toBe(context)
    } finally {
      await manager.close()
    }
  })

  it('sanitizes import failures while retaining the original cause', async () => {
    const cause = new Error('module unavailable at private installation path')
    vi.doMock('playwright', () => { throw cause })
    const { BrowserManager } = await import('../browser/browser-manager.js')
    const manager = new BrowserManager()

    const error = await manager.launch().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'BrowserLaunchError', message: 'BROWSER_LAUNCH_FAILED' })
    // Vitest wraps a failing module factory before exposing it to dynamic import.
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(String(error)).toBe('BrowserLaunchError: BROWSER_LAUNCH_FAILED')
  })
})
