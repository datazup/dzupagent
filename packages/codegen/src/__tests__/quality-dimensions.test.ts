import { describe, it, expect } from 'vitest'
import {
  typeStrictness,
  eslintClean,
  hasTests,
  codeCompleteness,
  hasJsDoc,
  builtinDimensions,
} from '../quality/quality-dimensions.js'

// ---------------------------------------------------------------------------
// typeStrictness
// ---------------------------------------------------------------------------

describe('typeStrictness', () => {
  it('passes when no any/ts-ignore used', async () => {
    const vfs = {
      'src/service.ts': 'export function greet(name: string): string { return name }',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(typeStrictness.maxPoints)
    expect(result.errors).toHaveLength(0)
  })

  it('detects explicit any types', async () => {
    const vfs = {
      'src/bad.ts': 'export function handle(data: any): any { return data as any }',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('any')
  })

  it('detects @ts-ignore directives', async () => {
    const vfs = {
      'src/hack.ts': '// @ts-ignore\nconst x = badCall()\nexport { x }',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.errors.some((e) => e.includes('ts-ignore'))).toBe(true)
  })

  it('detects @ts-nocheck directives', async () => {
    const vfs = {
      'src/legacy.ts': '// @ts-nocheck\nexport const x = 1',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.errors.some((e) => e.includes('ts-nocheck'))).toBe(true)
  })

  it('ignores non-TypeScript files', async () => {
    const vfs = {
      'src/config.json': '{ "any": true }',
      'README.md': 'Use any approach',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('ignores .d.ts declaration files', async () => {
    const vfs = {
      'src/types.d.ts': 'declare const data: any',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.passed).toBe(true)
  })

  it('score decreases proportionally to violations', async () => {
    const vfs = {
      'src/a.ts': 'export const x: any = 1',
      'src/b.ts': 'export const y: string = "clean"',
    }
    const result = await typeStrictness.evaluate(vfs)

    expect(result.score).toBeLessThan(typeStrictness.maxPoints)
    expect(result.score).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// eslintClean
// ---------------------------------------------------------------------------

describe('eslintClean', () => {
  it('passes when no debug statements found', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { return 42 }',
    }
    const result = await eslintClean.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns on console.log in source files', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { console.log("debug"); return 42 }',
    }
    const result = await eslintClean.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.warnings.some((w) => w.includes('console.log'))).toBe(true)
  })

  it('warns on debugger statements', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { debugger; return 42 }',
    }
    const result = await eslintClean.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.warnings.some((w) => w.includes('debugger'))).toBe(true)
  })

  it('warns on alert() calls', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { alert("hey") }',
    }
    const result = await eslintClean.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.warnings.some((w) => w.includes('alert()'))).toBe(true)
  })

  it('ignores console.log in test files', async () => {
    const vfs = {
      'src/service.test.ts': 'console.log("test output")',
    }
    const result = await eslintClean.evaluate(vfs)

    expect(result.passed).toBe(true)
  })

  it('ignores non-TypeScript files', async () => {
    const vfs = {
      'README.md': 'Use console.log for debugging',
    }
    const result = await eslintClean.evaluate(vfs)

    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasTests
// ---------------------------------------------------------------------------

describe('hasTests', () => {
  it('passes when all source files have test files', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/service.test.ts': 'describe("Service", () => {})',
    }
    const result = await hasTests.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(hasTests.maxPoints)
  })

  it('warns when source files lack test coverage', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/utils.ts': 'export function helper() {}',
      'src/service.test.ts': 'describe("Service", () => {})',
    }
    const result = await hasTests.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.warnings.some((w) => w.includes('utils.ts'))).toBe(true)
  })

  it('handles .spec.ts naming convention', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/service.spec.ts': 'describe("Service", () => {})',
    }
    const result = await hasTests.evaluate(vfs)

    expect(result.passed).toBe(true)
  })

  it('skips index files from coverage check', async () => {
    const vfs = {
      'src/index.ts': 'export { Service } from "./service"',
    }
    const result = await hasTests.evaluate(vfs)

    // No source files to check (index is skipped)
    expect(result.passed).toBe(true)
    expect(result.score).toBe(hasTests.maxPoints)
  })

  it('returns full score when no source files exist', async () => {
    const vfs = {
      'README.md': '# Project',
    }
    const result = await hasTests.evaluate(vfs)

    expect(result.score).toBe(hasTests.maxPoints)
  })

  it('calculates partial score based on coverage ratio', async () => {
    const vfs = {
      'src/a.ts': 'export const a = 1',
      'src/b.ts': 'export const b = 2',
      'src/c.ts': 'export const c = 3',
      'src/a.test.ts': 'test("a", () => {})',
    }
    const result = await hasTests.evaluate(vfs)

    // 1 of 3 covered => ~33% score
    expect(result.score).toBeLessThan(hasTests.maxPoints)
    expect(result.score).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// codeCompleteness
// ---------------------------------------------------------------------------

describe('codeCompleteness', () => {
  it('passes when no empty bodies or TODO/FIXME', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { return 42 }',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('detects empty arrow function bodies', async () => {
    const vfs = {
      'src/stub.ts': 'export const handler = () => {}',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.errors.some((e) => e.includes('empty function body'))).toBe(true)
  })

  it('detects empty anonymous function bodies', async () => {
    const vfs = {
      'src/stub.ts': 'export const handler = function() {}',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.passed).toBe(false)
  })

  it('warns on FIXME markers in code lines', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { const x = 1 FIXME return x }',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.warnings.some((w) => w.includes('FIXME'))).toBe(true)
  })

  it('warns on TODO markers in code lines', async () => {
    const vfs = {
      'src/service.ts': 'export function run() { const x = 1 TODO return x }',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.warnings.some((w) => w.includes('TODO'))).toBe(true)
  })

  it('ignores TODO/FIXME in pure comment lines', async () => {
    const vfs = {
      'src/service.ts': '// TODO: implement later\nexport function run() { return 42 }',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.warnings).toHaveLength(0)
  })

  it('ignores TODO/FIXME in JSDoc comments', async () => {
    const vfs = {
      'src/service.ts': '/** TODO: update docs */\nexport function run() { return 42 }',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.warnings).toHaveLength(0)
  })

  it('ignores test files', async () => {
    const vfs = {
      'src/service.test.ts': 'const stub = () => {} // FIXME',
    }
    const result = await codeCompleteness.evaluate(vfs)

    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasJsDoc
// ---------------------------------------------------------------------------

describe('hasJsDoc', () => {
  it('passes when all exports have JSDoc', async () => {
    const vfs = {
      'src/service.ts': `/** Service class */
export class Service {}

/** Greet the user */
export function greet() { return "hi" }
`,
    }
    const result = await hasJsDoc.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(hasJsDoc.maxPoints)
  })

  it('warns when exports lack JSDoc', async () => {
    const vfs = {
      'src/service.ts': `export class Service {}
export function greet() { return "hi" }
`,
    }
    const result = await hasJsDoc.evaluate(vfs)

    expect(result.passed).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('recognizes multi-line JSDoc comments', async () => {
    const vfs = {
      'src/service.ts': `/**
 * A complex service.
 * @param name - the name
 */
export function process(name: string) { return name }
`,
    }
    const result = await hasJsDoc.evaluate(vfs)

    expect(result.passed).toBe(true)
  })

  it('returns full score when no exports exist', async () => {
    const vfs = {
      'src/internal.ts': 'const x = 42',
    }
    const result = await hasJsDoc.evaluate(vfs)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(hasJsDoc.maxPoints)
  })

  it('calculates partial score', async () => {
    const vfs = {
      'src/service.ts': `/** Documented */
export function a() {}
export function b() {}
export function c() {}
`,
    }
    const result = await hasJsDoc.evaluate(vfs)

    // 1 of 3 documented
    expect(result.score).toBeLessThan(hasJsDoc.maxPoints)
    expect(result.score).toBeGreaterThan(0)
  })

  it('ignores test files', async () => {
    const vfs = {
      'src/service.test.ts': 'export function helper() {}',
    }
    const result = await hasJsDoc.evaluate(vfs)

    expect(result.passed).toBe(true)
  })

  it('detects export const declarations', async () => {
    const vfs = {
      'src/config.ts': 'export const CONFIG = { debug: false }',
    }
    const result = await hasJsDoc.evaluate(vfs)

    expect(result.warnings.some((w) => w.includes('CONFIG'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// builtinDimensions
// ---------------------------------------------------------------------------

describe('builtinDimensions', () => {
  it('exports 5 built-in dimensions', () => {
    expect(builtinDimensions).toHaveLength(5)
  })

  it('each dimension has name, maxPoints, and evaluate', () => {
    for (const dim of builtinDimensions) {
      expect(dim.name).toBeDefined()
      expect(dim.maxPoints).toBeGreaterThan(0)
      expect(typeof dim.evaluate).toBe('function')
    }
  })

  it('total max points sum to 50', () => {
    const total = builtinDimensions.reduce((sum, d) => sum + d.maxPoints, 0)
    expect(total).toBe(50)
  })
})
