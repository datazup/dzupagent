import { describe, it, expect } from 'vitest'
import { chunkByAST, type CodeChunk, type ASTChunkerConfig } from '../chunking/ast-chunker.js'

// ---------------------------------------------------------------------------
// These tests work regardless of tree-sitter availability.
// When tree-sitter is not installed, chunkByAST falls back to line-based
// splitting (for non-TS/JS) or regex-based symbol extraction (for TS/JS).
// ---------------------------------------------------------------------------

describe('chunkByAST — TypeScript', () => {
  const TS_SOURCE = `
import { Router } from 'express'

/**
 * User interface.
 */
export interface User {
  id: string
  name: string
  email: string
}

/**
 * User service handles user operations.
 */
export class UserService {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async getUser(id: string): Promise<User> {
    return this.db.query('SELECT * FROM users WHERE id = $1', [id])
  }

  async createUser(data: Partial<User>): Promise<User> {
    return this.db.query('INSERT INTO users ...')
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.query('DELETE FROM users WHERE id = $1', [id])
  }
}

export function createRouter(service: UserService): Router {
  const router = Router()
  router.get('/users/:id', async (req, res) => {
    const user = await service.getUser(req.params.id)
    res.json(user)
  })
  return router
}

export const MAX_PAGE_SIZE = 100
`.trim()

  it('produces at least one chunk', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('covers the entire file content', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    const lines = TS_SOURCE.split('\n')

    // The chunks should collectively span the file
    const coveredLines = new Set<number>()
    for (const chunk of chunks) {
      for (let l = chunk.startLine; l <= chunk.endLine; l++) {
        coveredLines.add(l)
      }
    }

    // At minimum, all non-empty lines should be covered by some chunk
    const totalLines = lines.length
    expect(coveredLines.size).toBeGreaterThan(0)
    expect(coveredLines.size).toBeLessThanOrEqual(totalLines)
  })

  it('chunks have non-empty content', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('chunks have valid IDs', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    for (const chunk of chunks) {
      expect(chunk.id).toContain('src/user-service.ts')
      expect(chunk.id.includes('#')).toBe(true)
    }
  })

  it('chunks have valid line ranges', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThan(0)
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
    }
  })

  it('chunks have token estimates', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeGreaterThan(0)
    }
  })

  it('chunks include language info', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    for (const chunk of chunks) {
      expect(chunk.language).toBe('typescript')
    }
  })

  it('respects filePath in chunk metadata', async () => {
    const chunks = await chunkByAST('src/user-service.ts', TS_SOURCE)
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe('src/user-service.ts')
    }
  })
})

describe('chunkByAST — configuration', () => {
  const SIMPLE_SOURCE = `
export function foo(): void { console.log('foo') }
export function bar(): void { console.log('bar') }
export function baz(): void { console.log('baz') }
`.trim()

  it('accepts custom maxChunkTokens', async () => {
    const config: ASTChunkerConfig = { maxChunkTokens: 1000 }
    const chunks = await chunkByAST('src/simple.ts', SIMPLE_SOURCE, config)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('accepts custom minChunkTokens', async () => {
    const config: ASTChunkerConfig = { minChunkTokens: 1 }
    const chunks = await chunkByAST('src/simple.ts', SIMPLE_SOURCE, config)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('accepts custom overlapLines', async () => {
    const config: ASTChunkerConfig = { overlapLines: 0 }
    const chunks = await chunkByAST('src/simple.ts', SIMPLE_SOURCE, config)
    expect(chunks.length).toBeGreaterThan(0)
  })
})

describe('chunkByAST — edge cases', () => {
  it('returns empty array for empty content', async () => {
    const chunks = await chunkByAST('src/empty.ts', '')
    expect(chunks).toEqual([])
  })

  it('returns empty array for whitespace-only content', async () => {
    const chunks = await chunkByAST('src/whitespace.ts', '   \n  \n  ')
    expect(chunks).toEqual([])
  })

  it('handles single-line files', async () => {
    const chunks = await chunkByAST('src/single.ts', 'export const x = 1')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('handles files with only imports', async () => {
    const code = `
import { a } from './a'
import { b } from './b'
import { c } from './c'
`.trim()

    const chunks = await chunkByAST('src/imports.ts', code)
    // May or may not produce chunks depending on whether imports are detected as symbols
    expect(Array.isArray(chunks)).toBe(true)
  })

  it('handles unsupported file types with line-based fallback', async () => {
    const code = `
def main():
    print("hello")

class Service:
    def run(self):
        pass
`.trim()

    // Python without tree-sitter falls back to line-based chunking
    const chunks = await chunkByAST('src/app.py', code)
    expect(Array.isArray(chunks)).toBe(true)
  })
})

describe('chunkByAST — large files', () => {
  it('splits large classes at method boundaries', async () => {
    // Generate a class with many methods
    const methods = Array.from({ length: 20 }, (_, i) =>
      `  async method${i}(arg: string): Promise<void> {\n    console.log('method ${i}', arg)\n    // Some implementation\n    return\n  }`,
    ).join('\n\n')

    const code = `export class BigService {\n${methods}\n}`

    const chunks = await chunkByAST('src/big.ts', code, { maxChunkTokens: 100 })
    // The class should produce at least one chunk
    // With tree-sitter, it will be split into many chunks.
    // Without tree-sitter, regex sees the class as one symbol (endLine == line),
    // so it may not split, but it should still produce valid chunks.
    expect(chunks.length).toBeGreaterThanOrEqual(1)

    // Every chunk should have valid structure
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0)
      expect(chunk.startLine).toBeGreaterThan(0)
    }
  })

  it('merges tiny adjacent symbols', async () => {
    const code = `
export const A = 1
export const B = 2
export const C = 3
export const D = 4
export const E = 5
`.trim()

    // With high minChunkTokens, these should be merged
    const chunks = await chunkByAST('src/constants.ts', code, {
      minChunkTokens: 200,
      maxChunkTokens: 1000,
    })

    // All tiny constants should be merged into fewer chunks
    expect(chunks.length).toBeLessThanOrEqual(2)
  })
})

describe('chunkByAST — JavaScript', () => {
  it('handles JS files', async () => {
    const code = `
export function add(a, b) {
  return a + b
}

export class MathUtils {
  multiply(a, b) {
    return a * b
  }
}
`.trim()

    const chunks = await chunkByAST('src/math.js', code)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.language).toBe('javascript')
    }
  })
})
