import { describe, it, expect } from 'vitest'
import { validateFormat, detectFormat, FORMAT_ADAPTERS } from '../output/format-adapter.js'

describe('validateFormat', () => {
  it('validates correct JSON', () => {
    const result = validateFormat('{"key": "value"}', 'json')
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects invalid JSON', () => {
    const result = validateFormat('{bad json}', 'json')
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('validates YAML key-value content', () => {
    expect(validateFormat('name: test\nversion: 1', 'yaml').valid).toBe(true)
  })

  it('validates YAML with document marker', () => {
    expect(validateFormat('---\nname: test', 'yaml').valid).toBe(true)
  })

  it('rejects non-YAML content', () => {
    expect(validateFormat('just plain text', 'yaml').valid).toBe(false)
  })

  it('validates markdown with headings', () => {
    expect(validateFormat('# Title\nSome text', 'markdown').valid).toBe(true)
  })

  it('validates markdown with lists', () => {
    expect(validateFormat('- item one\n- item two', 'markdown').valid).toBe(true)
  })

  it('validates HTML with tags', () => {
    expect(validateFormat('<div>hello</div>', 'html').valid).toBe(true)
  })

  it('rejects non-HTML', () => {
    expect(validateFormat('no tags here', 'html').valid).toBe(false)
  })

  it('validates mermaid diagram', () => {
    expect(validateFormat('graph TD\n  A-->B', 'mermaid').valid).toBe(true)
    expect(validateFormat('sequenceDiagram\n  A->>B: msg', 'mermaid').valid).toBe(true)
  })

  it('rejects non-mermaid content', () => {
    expect(validateFormat('not a diagram', 'mermaid').valid).toBe(false)
  })

  it('plain format is always valid', () => {
    expect(validateFormat('', 'plain').valid).toBe(true)
    expect(validateFormat('anything at all', 'plain').valid).toBe(true)
  })

  it('validates OpenAPI content', () => {
    expect(validateFormat('openapi: "3.0.0"\ninfo:', 'openapi').valid).toBe(true)
  })

  it('validates Prisma schema', () => {
    expect(validateFormat('model User {\n  id Int @id\n}', 'prisma').valid).toBe(true)
  })

  it('validates SQL content', () => {
    expect(validateFormat('SELECT * FROM users', 'sql').valid).toBe(true)
    expect(validateFormat('CREATE TABLE foo (id INT)', 'sql').valid).toBe(true)
  })
})

describe('detectFormat', () => {
  it('detects JSON', () => {
    expect(detectFormat('{"key": "value"}')).toBe('json')
  })

  it('detects JSON array', () => {
    expect(detectFormat('[1, 2, 3]')).toBe('json')
  })

  it('detects HTML', () => {
    expect(detectFormat('<html><body>Hello</body></html>')).toBe('html')
  })

  it('detects mermaid', () => {
    expect(detectFormat('flowchart LR\n  A-->B')).toBe('mermaid')
  })

  it('detects markdown', () => {
    expect(detectFormat('# Title\n\nSome paragraph')).toBe('markdown')
  })

  it('falls back to plain for unrecognized content', () => {
    expect(detectFormat('hello world')).toBe('plain')
  })
})

describe('FORMAT_ADAPTERS', () => {
  it('has adapters for all standard formats', () => {
    const expected = ['json', 'yaml', 'markdown', 'html', 'mermaid', 'openapi', 'prisma', 'sql', 'plain']
    for (const fmt of expected) {
      expect(FORMAT_ADAPTERS[fmt]).toBeDefined()
      expect(FORMAT_ADAPTERS[fmt].format).toBe(fmt)
    }
  })

  it('json adapter extracts parsed data', () => {
    const data = FORMAT_ADAPTERS['json'].extract('{"a": 1}')
    expect(data).toEqual({ a: 1 })
  })

  it('json adapter returns null for invalid JSON', () => {
    expect(FORMAT_ADAPTERS['json'].extract('not json')).toBeNull()
  })
})
