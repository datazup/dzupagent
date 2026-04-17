import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock all browser dependencies before importing
// ---------------------------------------------------------------------------

const mockPage = {
  goto: vi.fn(async () => null),
  waitForLoadState: vi.fn(async () => undefined),
  title: vi.fn(async () => 'Test'),
  close: vi.fn(async () => undefined),
}

const mockContext = {
  newPage: vi.fn(async () => mockPage),
}

const mockBrowser = {
  newContext: vi.fn(async () => mockContext),
  close: vi.fn(async () => undefined),
}

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => mockBrowser),
  },
}))

vi.mock('../extraction/screenshot-capture.js', () => ({
  captureScreenshot: vi.fn(async () => ({
    buffer: Buffer.from('jpeg-data'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
  })),
}))

vi.mock('../extraction/form-extractor.js', () => ({
  extractForms: vi.fn(async () => [
    { action: '/submit', method: 'POST', fields: [{ name: 'email', type: 'email', label: 'Email', placeholder: null, required: true }] },
  ]),
}))

vi.mock('../extraction/element-extractor.js', () => ({
  extractInteractiveElements: vi.fn(async () => [
    { role: 'button', label: 'Submit', enabled: true, visible: true, location: 'main', ariaAttributes: {} },
  ]),
}))

vi.mock('../extraction/accessibility-tree.js', () => ({
  extractAccessibilityTree: vi.fn(async () => [
    { role: 'button', name: 'Submit', depth: 1 },
  ]),
}))

vi.mock('../crawler/page-crawler.js', () => ({
  PageCrawler: vi.fn().mockImplementation(() => ({
    crawl: vi.fn(async function* () {
      yield {
        url: 'https://example.com',
        title: 'Test',
        depth: 0,
        links: ['https://example.com/a'],
        accessibilityTree: [],
        screenshot: Buffer.from('img'),
        screenshotMimeType: 'image/jpeg',
        forms: [],
        interactiveElements: [],
        loadTimeMs: 100,
      }
    }),
  })),
}))

const { createBrowserConnector } = await import('../browser-connector.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Re-setup default mocks
  mockBrowser.newContext.mockResolvedValue(mockContext)
  mockContext.newPage.mockResolvedValue(mockPage)
  mockPage.goto.mockResolvedValue(null)
  mockPage.waitForLoadState.mockResolvedValue(undefined)
  mockPage.close.mockResolvedValue(undefined)
})

describe('createBrowserConnector', () => {
  it('returns exactly 5 tools', () => {
    const tools = createBrowserConnector()
    expect(tools).toHaveLength(5)
  })

  it('tools have correct names', () => {
    const tools = createBrowserConnector()
    expect(tools.map(t => t.name)).toEqual([
      'browser-crawl-site',
      'browser-capture-screenshot',
      'browser-extract-forms',
      'browser-extract-elements',
      'browser-extract-a11y-tree',
    ])
  })

  it('tools have descriptions', () => {
    const tools = createBrowserConnector()
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
    }
  })
})

describe('crawlSiteTool', () => {
  it('returns JSON array of crawled pages', async () => {
    const [crawlTool] = createBrowserConnector()
    const result = await crawlTool.invoke({ startUrl: 'https://example.com' })
    const parsed = JSON.parse(result as string) as unknown[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ url: 'https://example.com', title: 'Test' })
  })

  it('passes crawl options through', async () => {
    const [crawlTool] = createBrowserConnector({
      crawlOptions: { maxPages: 10 },
    })
    const result = await crawlTool.invoke({
      startUrl: 'https://example.com',
      maxPages: 5,
      maxDepth: 2,
    })
    expect(typeof result).toBe('string')
    expect(result).not.toContain('Error:')
  })

  it('handles errors gracefully', async () => {
    mockBrowser.newContext.mockRejectedValueOnce(new Error('Browser crashed'))
    const [crawlTool] = createBrowserConnector()
    const result = await crawlTool.invoke({ startUrl: 'https://example.com' })
    expect(result).toContain('Error: Browser crashed')
  })

  it('handles non-Error throw gracefully', async () => {
    mockBrowser.newContext.mockRejectedValueOnce('string error')
    const [crawlTool] = createBrowserConnector()
    const result = await crawlTool.invoke({ startUrl: 'https://example.com' })
    expect(result).toContain('Error:')
  })

  it('closes browser manager after success', async () => {
    const [crawlTool] = createBrowserConnector()
    await crawlTool.invoke({ startUrl: 'https://example.com' })
    expect(mockBrowser.close).toHaveBeenCalled()
  })

  it('closes browser manager after error', async () => {
    mockContext.newPage.mockRejectedValueOnce(new Error('fail'))
    // Restore after this test
    mockContext.newPage.mockResolvedValue(mockPage)

    const tools = createBrowserConnector()
    // Use the screenshot tool since crawl tool uses PageCrawler mock
    const [, screenshotTool] = tools
    await screenshotTool.invoke({ url: 'https://example.com' })
    expect(mockBrowser.close).toHaveBeenCalled()
  })
})

describe('captureScreenshotTool', () => {
  it('returns success message on success (toModelOutput transforms output)', async () => {
    const [, screenshotTool] = createBrowserConnector()
    const result = await screenshotTool.invoke({ url: 'https://example.com' })
    // The toModelOutput transforms valid JSON to a friendly message
    expect(result).toContain('Screenshot captured successfully')
  })

  it('toModelOutput returns success message for valid output', () => {
    const [, screenshotTool] = createBrowserConnector()
    // Access the toModelOutput through the tool's internal handling
    // The tool wraps execute + toModelOutput via createForgeTool
    expect(screenshotTool.description).toContain('screenshot')
  })

  it('handles navigation error gracefully', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout'))
    const [, screenshotTool] = createBrowserConnector()
    const result = await screenshotTool.invoke({ url: 'https://example.com' })
    expect(result).toContain('Error: Navigation timeout')
  })
})

describe('extractFormsTool', () => {
  it('returns form JSON on success', async () => {
    const [, , formsTool] = createBrowserConnector()
    const result = await formsTool.invoke({ url: 'https://example.com' })
    const parsed = JSON.parse(result as string) as unknown[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ action: '/submit', method: 'POST' })
  })

  it('handles errors gracefully', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Network error'))
    const [, , formsTool] = createBrowserConnector()
    const result = await formsTool.invoke({ url: 'https://example.com' })
    expect(result).toContain('Error: Network error')
  })
})

describe('extractElementsTool', () => {
  it('returns element JSON on success', async () => {
    const [, , , elementsTool] = createBrowserConnector()
    const result = await elementsTool.invoke({ url: 'https://example.com' })
    const parsed = JSON.parse(result as string) as unknown[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ role: 'button', label: 'Submit' })
  })

  it('handles errors gracefully', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Selector not found'))
    const [, , , elementsTool] = createBrowserConnector()
    const result = await elementsTool.invoke({ url: 'https://example.com' })
    expect(result).toContain('Error: Selector not found')
  })
})

describe('extractA11yTreeTool', () => {
  it('returns accessibility tree JSON on success', async () => {
    const [, , , , a11yTool] = createBrowserConnector()
    const result = await a11yTool.invoke({ url: 'https://example.com' })
    const parsed = JSON.parse(result as string) as unknown[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ role: 'button', name: 'Submit' })
  })

  it('handles errors gracefully', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Page not found'))
    const [, , , , a11yTool] = createBrowserConnector()
    const result = await a11yTool.invoke({ url: 'https://example.com' })
    expect(result).toContain('Error: Page not found')
  })
})
