import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BrowserManager } from '../browser/browser-manager.js'

// Mock playwright
const mockBrowser = {
  newContext: vi.fn(),
  close: vi.fn(),
}

const mockContext = {
  newPage: vi.fn(),
}

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => mockBrowser),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockBrowser.newContext.mockResolvedValue(mockContext)
  mockBrowser.close.mockResolvedValue(undefined)
})

describe('BrowserManager', () => {
  it('launches a browser in headless mode by default', async () => {
    const manager = new BrowserManager()
    await manager.launch()

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledWith({ headless: true })
  })

  it('launches with headless false when specified', async () => {
    const manager = new BrowserManager()
    await manager.launch({ headless: false })

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledWith({ headless: false })
  })

  it('does not pass an args array when no typed launch option needs one', async () => {
    const manager = new BrowserManager()
    await manager.launch({ headless: true, viewport: { width: 800, height: 600 } })

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledWith({ headless: true })
  })

  it('forwards hostResolverRules to chromium as --host-resolver-rules', async () => {
    const manager = new BrowserManager()
    await manager.launch({
      headless: true,
      hostResolverRules: [
        { host: 'target.example.com', address: '93.184.216.34' },
      ],
    })

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledWith({
      headless: true,
      args: ['--host-resolver-rules=MAP target.example.com 93.184.216.34'],
    })
  })

  it('renders every pin into a single comma-joined flag', async () => {
    const manager = new BrowserManager()
    await manager.launch({
      hostResolverRules: [
        { host: 'a.example.com', address: '1.2.3.4' },
        { host: 'b.example.com', address: '::1', port: 8443 },
      ],
    })

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledWith({
      headless: true,
      args: ['--host-resolver-rules=MAP a.example.com 1.2.3.4,MAP b.example.com [::1]:8443'],
    })
  })

  it('throws before launching when a pin is invalid (fail-closed)', async () => {
    const manager = new BrowserManager()
    await expect(
      manager.launch({
        hostResolverRules: [
          { host: 'target.example.com', address: 'attacker.example.com' },
        ],
      })
    ).rejects.toThrow(/address must be an IPv4 or IPv6 literal/)

    const { chromium } = await import('playwright')
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it('does not launch twice if already launched', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.launch()

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledTimes(1)
  })

  it('creates a new context with default viewport', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.newContext()

    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
    })
  })

  it('creates a context with custom viewport', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.newContext({ viewport: { width: 800, height: 600 } })

    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 800, height: 600 },
    })
  })

  it('creates a context with proxy settings', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.newContext({ proxy: { server: 'http://proxy:8080' } })

    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
      proxy: { server: 'http://proxy:8080' },
    })
  })

  it('creates a context with service workers blocked when requested', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.newContext({ serviceWorkers: 'block' })

    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
    })
  })

  it('throws if newContext is called before launch', async () => {
    const manager = new BrowserManager()
    await expect(manager.newContext()).rejects.toThrow('Browser not launched')
  })

  it('closes the browser', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.close()

    expect(mockBrowser.close).toHaveBeenCalled()
  })

  it('is safe to close when no browser is launched', async () => {
    const manager = new BrowserManager()
    await expect(manager.close()).resolves.toBeUndefined()
  })

  it('allows re-launch after close', async () => {
    const manager = new BrowserManager()
    await manager.launch()
    await manager.close()
    await manager.launch()

    const { chromium } = await import('playwright')
    expect(chromium.launch).toHaveBeenCalledTimes(2)
  })
})
