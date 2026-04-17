import { describe, it, expect } from 'vitest'
import {
  parseCodeBlocks,
  extractLargestCodeBlock,
  detectLanguage,
} from '../generation/code-block-parser.js'

// ---------------------------------------------------------------------------
// parseCodeBlocks
// ---------------------------------------------------------------------------

describe('parseCodeBlocks', () => {
  it('extracts a single code block with language', () => {
    const text = '```typescript\nconst x = 1\n```'
    const blocks = parseCodeBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('typescript')
    expect(blocks[0]!.content).toBe('const x = 1')
  })

  it('extracts multiple code blocks', () => {
    const text = '```js\na()\n```\nSome text\n```python\nb()\n```'
    const blocks = parseCodeBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.language).toBe('js')
    expect(blocks[1]!.language).toBe('python')
  })

  it('handles code block with no language', () => {
    const text = '```\nhello\n```'
    const blocks = parseCodeBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('')
    expect(blocks[0]!.content).toBe('hello')
  })

  it('returns empty for text without code blocks', () => {
    expect(parseCodeBlocks('just plain text')).toHaveLength(0)
  })

  it('handles empty code blocks', () => {
    const text = '```ts\n\n```'
    const blocks = parseCodeBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.content).toBe('')
  })

  it('handles multiline content', () => {
    const text = '```\nline1\nline2\nline3\n```'
    const blocks = parseCodeBlocks(text)
    expect(blocks[0]!.content).toContain('line1')
    expect(blocks[0]!.content).toContain('line3')
  })
})

// ---------------------------------------------------------------------------
// extractLargestCodeBlock
// ---------------------------------------------------------------------------

describe('extractLargestCodeBlock', () => {
  it('returns the largest code block content', () => {
    const text = '```ts\nshort\n```\n```ts\nthis is a much longer block of code\n```'
    const result = extractLargestCodeBlock(text)
    expect(result).toBe('this is a much longer block of code')
  })

  it('returns the full text trimmed when no code blocks exist', () => {
    expect(extractLargestCodeBlock('  just text  ')).toBe('just text')
  })

  it('returns the only block if there is just one', () => {
    const text = '```js\nconst x = 1\n```'
    expect(extractLargestCodeBlock(text)).toBe('const x = 1')
  })
})

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  it('detects typescript from .ts', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript')
  })

  it('detects typescript from .tsx', () => {
    expect(detectLanguage('comp.tsx')).toBe('typescript')
  })

  it('detects javascript from .js', () => {
    expect(detectLanguage('app.js')).toBe('javascript')
  })

  it('detects vue', () => {
    expect(detectLanguage('App.vue')).toBe('vue')
  })

  it('detects json', () => {
    expect(detectLanguage('package.json')).toBe('json')
  })

  it('detects prisma', () => {
    expect(detectLanguage('schema.prisma')).toBe('prisma')
  })

  it('detects css', () => {
    expect(detectLanguage('styles.css')).toBe('css')
  })

  it('detects scss', () => {
    expect(detectLanguage('styles.scss')).toBe('scss')
  })

  it('detects yaml', () => {
    expect(detectLanguage('config.yaml')).toBe('yaml')
    expect(detectLanguage('config.yml')).toBe('yaml')
  })

  it('detects python', () => {
    expect(detectLanguage('app.py')).toBe('python')
  })

  it('detects rust', () => {
    expect(detectLanguage('main.rs')).toBe('rust')
  })

  it('detects go', () => {
    expect(detectLanguage('main.go')).toBe('go')
  })

  it('detects graphql', () => {
    expect(detectLanguage('schema.graphql')).toBe('graphql')
    expect(detectLanguage('query.gql')).toBe('graphql')
  })

  it('returns text for unknown extensions', () => {
    expect(detectLanguage('file.xyz')).toBe('text')
  })

  it('handles files with no extension', () => {
    expect(detectLanguage('Makefile')).toBe('text')
  })
})
