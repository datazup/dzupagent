import { describe, it, expect, beforeEach } from 'vitest'
import {
  extractSymbolsAST,
  isTreeSitterAvailable,
  detectLanguage,
  EXTENSION_MAP,
  _resetTreeSitterCache,
  type ASTSymbol,
  type SupportedLanguage,
} from '../repomap/tree-sitter-extractor.js'
import { extractSymbols } from '../repomap/symbol-extractor.js'

// ---------------------------------------------------------------------------
// These tests verify behavior both WITH and WITHOUT tree-sitter.
// When tree-sitter is not installed, extractSymbolsAST falls back to regex.
// The tests are structured to pass in both modes.
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetTreeSitterCache()
})

describe('detectLanguage', () => {
  it('maps TypeScript extensions', () => {
    expect(detectLanguage('src/app.ts')).toBe('typescript')
    expect(detectLanguage('src/app.tsx')).toBe('typescript')
  })

  it('maps JavaScript extensions', () => {
    expect(detectLanguage('src/app.js')).toBe('javascript')
    expect(detectLanguage('src/app.jsx')).toBe('javascript')
    expect(detectLanguage('src/app.mjs')).toBe('javascript')
  })

  it('maps Python extensions', () => {
    expect(detectLanguage('main.py')).toBe('python')
  })

  it('maps Go extensions', () => {
    expect(detectLanguage('main.go')).toBe('go')
  })

  it('maps Rust extensions', () => {
    expect(detectLanguage('lib.rs')).toBe('rust')
  })

  it('maps Java extensions', () => {
    expect(detectLanguage('Main.java')).toBe('java')
  })

  it('returns undefined for unsupported extensions', () => {
    expect(detectLanguage('style.css')).toBeUndefined()
    expect(detectLanguage('readme.md')).toBeUndefined()
    expect(detectLanguage('data.json')).toBeUndefined()
  })
})

describe('EXTENSION_MAP', () => {
  it('covers all expected extensions', () => {
    const expected = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java']
    for (const ext of expected) {
      expect(EXTENSION_MAP[ext]).toBeDefined()
    }
  })
})

describe('isTreeSitterAvailable', () => {
  it('returns a boolean', async () => {
    const result = await isTreeSitterAvailable()
    expect(typeof result).toBe('boolean')
  })

  it('returns a boolean for specific languages', async () => {
    const result = await isTreeSitterAvailable('typescript')
    expect(typeof result).toBe('boolean')
  })
})

describe('extractSymbolsAST — TypeScript', () => {
  const TS_SAMPLE = `
import { something } from './dep'

/**
 * A sample interface.
 */
export interface UserService {
  getUser(id: string): Promise<User>
  deleteUser(id: string): Promise<void>
}

export class UserController {
  private service: UserService

  constructor(service: UserService) {
    this.service = service
  }

  async getUser(id: string): Promise<User> {
    return this.service.getUser(id)
  }
}

export function createRouter(): Router {
  return new Router()
}

export const MAX_RETRIES = 3

type UserId = string

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

export const fetchUser = async (id: string): Promise<User> => {
  return api.get(\`/users/\${id}\`)
}
`.trim()

  it('extracts symbols from TypeScript (regex fallback or AST)', async () => {
    const symbols = await extractSymbolsAST('src/user.ts', TS_SAMPLE)

    // Both regex and AST should find these core symbols
    const names = symbols.map((s) => s.name)
    expect(names).toContain('UserService')
    expect(names).toContain('UserController')
    expect(names).toContain('createRouter')
    expect(names).toContain('Status')

    // Check kinds
    const byName = new Map(symbols.map((s) => [s.name, s]))
    expect(byName.get('UserService')?.kind).toBe('interface')
    expect(byName.get('UserController')?.kind).toBe('class')
    expect(byName.get('createRouter')?.kind).toBe('function')
    expect(byName.get('Status')?.kind).toBe('enum')
  })

  it('detects exported symbols', async () => {
    const symbols = await extractSymbolsAST('src/user.ts', TS_SAMPLE)
    const byName = new Map(symbols.map((s) => [s.name, s]))

    expect(byName.get('UserService')?.exported).toBe(true)
    expect(byName.get('UserController')?.exported).toBe(true)
    expect(byName.get('createRouter')?.exported).toBe(true)
    expect(byName.get('Status')?.exported).toBe(true)
  })

  it('has line numbers', async () => {
    const symbols = await extractSymbolsAST('src/user.ts', TS_SAMPLE)

    for (const sym of symbols) {
      expect(sym.line).toBeGreaterThan(0)
    }
  })

  it('includes ASTSymbol extended fields', async () => {
    const symbols = await extractSymbolsAST('src/user.ts', TS_SAMPLE)

    for (const sym of symbols) {
      const ast = sym as ASTSymbol
      expect(ast.endLine).toBeGreaterThanOrEqual(ast.line)
      expect(typeof ast.column).toBe('number')
      expect(typeof ast.endColumn).toBe('number')
      expect(ast.language).toBe('typescript')
    }
  })

  it('returns empty array for empty content', async () => {
    const symbols = await extractSymbolsAST('src/empty.ts', '')
    expect(symbols).toEqual([])
  })

  it('returns empty array for comment-only content', async () => {
    const symbols = await extractSymbolsAST('src/comments.ts', '// just a comment\n/* block comment */')
    expect(symbols).toEqual([])
  })

  it('is backward-compatible with regex extractSymbols', async () => {
    // extractSymbolsAST should produce a superset of what extractSymbols finds
    const regexSymbols = extractSymbols('src/user.ts', TS_SAMPLE)
    const astSymbols = await extractSymbolsAST('src/user.ts', TS_SAMPLE)

    // Every regex symbol name should appear in AST results
    for (const rs of regexSymbols) {
      const found = astSymbols.find((as) => as.name === rs.name)
      expect(found).toBeDefined()
    }
  })
})

describe('extractSymbolsAST — JavaScript', () => {
  const JS_SAMPLE = `
export function greet(name) {
  return \`Hello, \${name}\`
}

export class Calculator {
  add(a, b) {
    return a + b
  }
}

export const PI = 3.14159
`.trim()

  it('extracts symbols from JavaScript', async () => {
    const symbols = await extractSymbolsAST('src/utils.js', JS_SAMPLE)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('greet')
    expect(names).toContain('Calculator')
  })
})

describe('extractSymbolsAST — non-TS/JS languages', () => {
  // These test the fallback behavior: when tree-sitter is not installed,
  // non-TS/JS languages return empty arrays because regex only handles TS/JS.
  // When tree-sitter IS installed, they return proper AST symbols.

  it('handles Python files gracefully', async () => {
    const pyCode = `
class UserService:
    def get_user(self, user_id: str) -> dict:
        pass

def main():
    service = UserService()
`.trim()

    const symbols = await extractSymbolsAST('src/app.py', pyCode)
    // Result depends on tree-sitter availability
    expect(Array.isArray(symbols)).toBe(true)
  })

  it('handles Go files gracefully', async () => {
    const goCode = `
package main

func main() {
    fmt.Println("hello")
}

type UserService struct {
    db *sql.DB
}
`.trim()

    const symbols = await extractSymbolsAST('src/main.go', goCode)
    expect(Array.isArray(symbols)).toBe(true)
  })

  it('handles Rust files gracefully', async () => {
    const rsCode = `
pub struct Config {
    pub name: String,
}

pub fn create_config() -> Config {
    Config { name: String::new() }
}

pub trait Service {
    fn execute(&self);
}
`.trim()

    const symbols = await extractSymbolsAST('src/lib.rs', rsCode)
    expect(Array.isArray(symbols)).toBe(true)
  })

  it('handles Java files gracefully', async () => {
    const javaCode = `
public class UserController {
    public User getUser(String id) {
        return new User(id);
    }
}
`.trim()

    const symbols = await extractSymbolsAST('src/UserController.java', javaCode)
    expect(Array.isArray(symbols)).toBe(true)
  })
})

describe('extractSymbolsAST — unsupported extensions', () => {
  it('returns empty for CSS files', async () => {
    const symbols = await extractSymbolsAST('style.css', 'body { color: red; }')
    expect(symbols).toEqual([])
  })

  it('returns empty for JSON files', async () => {
    const symbols = await extractSymbolsAST('data.json', '{"key": "value"}')
    expect(symbols).toEqual([])
  })
})

describe('extractSymbolsAST — edge cases', () => {
  it('handles deeply nested classes', async () => {
    const code = `
export class Outer {
  method1(): void {}
  method2(): string { return '' }
}
`.trim()

    const symbols = await extractSymbolsAST('src/nested.ts', code)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Outer')
  })

  it('handles arrow function exports', async () => {
    const code = `
export const handler = async (req: Request): Promise<Response> => {
  return new Response('ok')
}
`.trim()

    const symbols = await extractSymbolsAST('src/handler.ts', code)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('handler')
  })

  it('handles re-exports gracefully', async () => {
    const code = `
export { foo } from './foo'
export { bar } from './bar'
export type { Baz } from './baz'
`.trim()

    // Re-exports are not symbol definitions; should not crash
    const symbols = await extractSymbolsAST('src/index.ts', code)
    expect(Array.isArray(symbols)).toBe(true)
  })

  it('handles abstract classes', async () => {
    const code = `
export abstract class BaseService {
  abstract execute(): Promise<void>
}
`.trim()

    const symbols = await extractSymbolsAST('src/base.ts', code)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('BaseService')

    const base = symbols.find((s) => s.name === 'BaseService')
    expect(base?.kind).toBe('class')
  })

  it('handles const enum', async () => {
    const code = `
export const enum Direction {
  Up = 'UP',
  Down = 'DOWN',
}
`.trim()

    const symbols = await extractSymbolsAST('src/enums.ts', code)
    const dir = symbols.find((s) => s.name === 'Direction')
    expect(dir).toBeDefined()
    expect(dir?.kind).toBe('enum')
  })
})
