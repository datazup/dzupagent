import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractForms } from '../extraction/form-extractor.js'
import { extractInteractiveElements } from '../extraction/element-extractor.js'
import { extractAccessibilityTree } from '../extraction/accessibility-tree.js'
import { captureScreenshot } from '../extraction/screenshot-capture.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --------------------------------------------------------------------------
// Form extractor
// --------------------------------------------------------------------------
describe('extractForms', () => {
  function createFormPage(formHtml: ReturnType<typeof vi.fn>) {
    return {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }
  }

  it('extracts a simple form with text input', async () => {
    const mockForm = {
      action: 'https://example.com/submit',
      method: 'post',
      querySelectorAll: () => [{
        tagName: 'INPUT',
        type: 'text',
        name: 'username',
        id: 'username',
        placeholder: 'Enter username',
        required: true,
        getAttribute: () => null,
      }],
    }

    const mockDocument = {
      querySelectorAll: (sel: string) => sel === 'form' ? [mockForm] : [],
      querySelector: () => null,
    }

    vi.stubGlobal('document', mockDocument)

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const forms = await extractForms(page as never)
    expect(forms).toHaveLength(1)
    expect(forms[0]!.action).toBe('https://example.com/submit')
    expect(forms[0]!.method).toBe('POST')
    expect(forms[0]!.fields).toHaveLength(1)
    expect(forms[0]!.fields[0]!.name).toBe('username')
    expect(forms[0]!.fields[0]!.required).toBe(true)
  })

  it('returns empty array when no forms exist', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      querySelector: () => null,
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const forms = await extractForms(page as never)
    expect(forms).toEqual([])
  })

  it('extracts select field options', async () => {
    const mockSelect = {
      tagName: 'SELECT',
      name: 'color',
      id: 'color',
      placeholder: null,
      required: false,
      options: [
        { text: 'Red' },
        { text: 'Blue' },
        { text: 'Green' },
      ],
      getAttribute: () => null,
    }

    const mockForm = {
      action: '',
      method: 'get',
      querySelectorAll: () => [mockSelect],
    }

    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => sel === 'form' ? [mockForm] : [],
      querySelector: () => null,
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const forms = await extractForms(page as never)
    expect(forms[0]!.fields[0]!.type).toBe('select')
    expect(forms[0]!.fields[0]!.options).toEqual(['Red', 'Blue', 'Green'])
  })

  it('extracts textarea fields', async () => {
    const mockTextarea = {
      tagName: 'TEXTAREA',
      name: 'message',
      id: 'message',
      placeholder: 'Enter message',
      required: false,
      getAttribute: () => null,
    }

    const mockForm = {
      action: '',
      method: 'post',
      querySelectorAll: () => [mockTextarea],
    }

    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => sel === 'form' ? [mockForm] : [],
      querySelector: () => null,
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const forms = await extractForms(page as never)
    expect(forms[0]!.fields[0]!.type).toBe('textarea')
    expect(forms[0]!.fields[0]!.name).toBe('message')
  })
})

// --------------------------------------------------------------------------
// Element extractor
// --------------------------------------------------------------------------
describe('extractInteractiveElements', () => {
  it('extracts a button element', async () => {
    const mockButton = {
      tagName: 'BUTTON',
      textContent: 'Submit',
      disabled: false,
      getAttribute: (attr: string) => (attr === 'role' ? null : null),
      closest: () => null,
      attributes: [] as unknown[],
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
    }

    vi.stubGlobal('document', {
      querySelectorAll: () => [mockButton],
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const elements = await extractInteractiveElements(page as never)
    expect(elements).toHaveLength(1)
    expect(elements[0]!.role).toBe('button')
    expect(elements[0]!.label).toBe('Submit')
    expect(elements[0]!.enabled).toBe(true)
    expect(elements[0]!.visible).toBe(true)
    expect(elements[0]!.location).toBe('main')
  })

  it('detects elements in navigation areas', async () => {
    const navEl = {
      tagName: 'NAV',
      getAttribute: () => null,
    }
    const mockLink = {
      tagName: 'A',
      textContent: 'Home',
      disabled: false,
      getAttribute: (attr: string) => (attr === 'role' ? null : null),
      closest: () => navEl,
      attributes: [] as unknown[],
      getBoundingClientRect: () => ({ width: 80, height: 20 }),
    }

    vi.stubGlobal('document', {
      querySelectorAll: () => [mockLink],
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const elements = await extractInteractiveElements(page as never)
    expect(elements[0]!.location).toBe('nav')
  })

  it('detects disabled elements', async () => {
    const mockButton = {
      tagName: 'BUTTON',
      textContent: 'Disabled',
      disabled: true,
      getAttribute: () => null,
      closest: () => null,
      attributes: [] as unknown[],
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
    }

    vi.stubGlobal('document', {
      querySelectorAll: () => [mockButton],
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const elements = await extractInteractiveElements(page as never)
    expect(elements[0]!.enabled).toBe(false)
  })

  it('detects invisible elements (zero dimensions)', async () => {
    const mockButton = {
      tagName: 'BUTTON',
      textContent: 'Hidden',
      disabled: false,
      getAttribute: () => null,
      closest: () => null,
      attributes: [] as unknown[],
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    }

    vi.stubGlobal('document', {
      querySelectorAll: () => [mockButton],
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const elements = await extractInteractiveElements(page as never)
    expect(elements[0]!.visible).toBe(false)
  })

  it('collects aria attributes', async () => {
    const mockButton = {
      tagName: 'BUTTON',
      textContent: 'Toggle',
      disabled: false,
      getAttribute: () => null,
      closest: () => null,
      attributes: [
        { name: 'aria-expanded', value: 'true' },
        { name: 'aria-controls', value: 'panel1' },
        { name: 'class', value: 'btn' },
      ],
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
    }

    vi.stubGlobal('document', {
      querySelectorAll: () => [mockButton],
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const elements = await extractInteractiveElements(page as never)
    expect(elements[0]!.ariaAttributes).toEqual({
      'aria-expanded': 'true',
      'aria-controls': 'panel1',
    })
  })

  it('returns empty array when no interactive elements', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const elements = await extractInteractiveElements(page as never)
    expect(elements).toEqual([])
  })
})

// --------------------------------------------------------------------------
// Screenshot capture (additional cases beyond existing test)
// --------------------------------------------------------------------------
describe('captureScreenshot', () => {
  it('captures viewport-only screenshot when fullPage is false', async () => {
    const mockPage = {
      viewportSize: () => ({ width: 1280, height: 720 }),
      screenshot: vi.fn(async () => Buffer.from('jpeg')),
    }

    const result = await captureScreenshot(mockPage as never, false)

    expect(mockPage.screenshot).toHaveBeenCalledWith({
      fullPage: false,
      type: 'jpeg',
      quality: 80,
    })
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
  })

  it('clips when page height exceeds 3x viewport', async () => {
    const mockPage = {
      viewportSize: () => ({ width: 1200, height: 800 }),
      evaluate: vi.fn(async () => 5000), // page is much taller
      screenshot: vi.fn(async () => Buffer.from('jpeg')),
    }

    const result = await captureScreenshot(mockPage as never, true)

    expect(mockPage.screenshot).toHaveBeenCalledWith({
      fullPage: false,
      type: 'jpeg',
      quality: 80,
      clip: { x: 0, y: 0, width: 1200, height: 2400 },
    })
    expect(result.height).toBe(2400)
  })

  it('uses default viewport size when viewportSize returns null', async () => {
    const mockPage = {
      viewportSize: () => null,
      screenshot: vi.fn(async () => Buffer.from('jpeg')),
    }

    const result = await captureScreenshot(mockPage as never, false)

    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
  })

  it('returns a Buffer in the result', async () => {
    const buf = Buffer.from('test-screenshot')
    const mockPage = {
      viewportSize: () => ({ width: 800, height: 600 }),
      evaluate: vi.fn(async () => 600),
      screenshot: vi.fn(async () => buf),
    }

    const result = await captureScreenshot(mockPage as never, true)
    expect(Buffer.isBuffer(result.buffer)).toBe(true)
  })
})

// --------------------------------------------------------------------------
// Accessibility tree
// --------------------------------------------------------------------------
describe('extractAccessibilityTree', () => {
  it('extracts elements with implicit ARIA roles', async () => {
    // The accessibility-tree code runs inside page.evaluate (normally in browser context)
    // which uses HTMLInputElement etc. We need to stub those browser globals.
    vi.stubGlobal('HTMLInputElement', class HTMLInputElement {})
    vi.stubGlobal('HTMLSelectElement', class HTMLSelectElement {})
    vi.stubGlobal('HTMLTextAreaElement', class HTMLTextAreaElement {})
    vi.stubGlobal('HTMLImageElement', class HTMLImageElement {})
    vi.stubGlobal('HTMLElement', class HTMLElement {})

    const buttonEl = {
      tagName: 'BUTTON',
      getAttribute: (attr: string) => {
        if (attr === 'aria-label') return 'Save'
        return null
      },
      hasAttribute: () => false,
      textContent: 'Save',
      children: [] as unknown[],
      required: false,
      attributes: [],
    }

    const htmlEl = {
      tagName: 'HTML',
      getAttribute: () => null,
      hasAttribute: () => false,
      textContent: 'Save',
      children: [buttonEl],
    }

    vi.stubGlobal('document', {
      documentElement: htmlEl,
      getElementById: () => null,
      querySelector: () => null,
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const tree = await extractAccessibilityTree(page as never)
    expect(tree.length).toBeGreaterThanOrEqual(1)
    const btn = tree.find(n => n.role === 'button')
    expect(btn).toBeDefined()
    expect(btn!.name).toBe('Save')
  })

  it('returns empty array for a page with no interactive elements', async () => {
    const htmlEl = {
      tagName: 'HTML',
      getAttribute: () => null,
      hasAttribute: () => false,
      textContent: '',
      children: [{
        tagName: 'DIV',
        getAttribute: () => null,
        hasAttribute: () => false,
        textContent: 'plain text',
        children: [] as unknown[],
      }],
    }

    vi.stubGlobal('document', {
      documentElement: htmlEl,
      getElementById: () => null,
      querySelector: () => null,
    })

    const page = {
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const tree = await extractAccessibilityTree(page as never)
    expect(tree).toEqual([])
  })
})
