import { describe, it, expect, beforeEach } from 'vitest'
import { QualityScorer } from '../quality/quality-scorer.js'
import {
  typeStrictness,
  eslintClean,
  hasTests,
  codeCompleteness,
  hasJsDoc,
  builtinDimensions,
} from '../quality/quality-dimensions.js'
import type { QualityDimension, DimensionResult } from '../quality/quality-types.js'

// ---------------------------------------------------------------------------
// QualityScorer
// ---------------------------------------------------------------------------

describe('QualityScorer', () => {
  let scorer: QualityScorer

  beforeEach(() => {
    scorer = new QualityScorer()
  })

  it('should return 0 quality with no dimensions', async () => {
    const result = await scorer.evaluate({})
    expect(result.quality).toBe(0)
    expect(result.success).toBe(true)
    expect(result.dimensions).toEqual([])
  })

  it('should aggregate scores from multiple dimensions', async () => {
    const perfectDim: QualityDimension = {
      name: 'perfect',
      maxPoints: 10,
      async evaluate(): Promise<DimensionResult> {
        return { name: 'perfect', score: 10, maxScore: 10, passed: true, errors: [], warnings: [] }
      },
    }
    const halfDim: QualityDimension = {
      name: 'half',
      maxPoints: 10,
      async evaluate(): Promise<DimensionResult> {
        return { name: 'half', score: 5, maxScore: 10, passed: true, errors: [], warnings: [] }
      },
    }

    scorer.addDimension(perfectDim).addDimension(halfDim)
    const result = await scorer.evaluate({})

    // (10 + 5) / (10 + 10) * 100 = 75
    expect(result.quality).toBe(75)
    expect(result.success).toBe(true)
    expect(result.dimensions).toHaveLength(2)
  })

  it('should set success to false when any dimension has errors', async () => {
    const failDim: QualityDimension = {
      name: 'fail',
      maxPoints: 10,
      async evaluate(): Promise<DimensionResult> {
        return { name: 'fail', score: 0, maxScore: 10, passed: false, errors: ['bad code'], warnings: [] }
      },
    }

    scorer.addDimension(failDim)
    const result = await scorer.evaluate({})

    expect(result.success).toBe(false)
    expect(result.errors).toEqual(['bad code'])
  })

  it('should collect warnings from all dimensions', async () => {
    const warnDim: QualityDimension = {
      name: 'warn',
      maxPoints: 5,
      async evaluate(): Promise<DimensionResult> {
        return { name: 'warn', score: 3, maxScore: 5, passed: true, errors: [], warnings: ['watch out'] }
      },
    }

    scorer.addDimension(warnDim)
    const result = await scorer.evaluate({})

    expect(result.warnings).toEqual(['watch out'])
  })

  it('should support addDimensions for batch addition', async () => {
    const dims: QualityDimension[] = [
      {
        name: 'a', maxPoints: 10,
        async evaluate(): Promise<DimensionResult> {
          return { name: 'a', score: 10, maxScore: 10, passed: true, errors: [], warnings: [] }
        },
      },
      {
        name: 'b', maxPoints: 10,
        async evaluate(): Promise<DimensionResult> {
          return { name: 'b', score: 10, maxScore: 10, passed: true, errors: [], warnings: [] }
        },
      },
    ]

    scorer.addDimensions(dims)
    const result = await scorer.evaluate({})
    expect(result.quality).toBe(100)
    expect(result.dimensions).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// typeStrictness dimension
// ---------------------------------------------------------------------------

describe('typeStrictness', () => {
  it('should score full points for clean TypeScript', async () => {
    const vfs = {
      'src/service.ts': `export class Service {
  async process(data: string): Promise<void> {}
}`,
    }

    const result = await typeStrictness.evaluate(vfs)
    expect(result.score).toBe(15)
    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should detect any type usage', async () => {
    const vfs = {
      'src/bad.ts': `export function process(data: any): any {
  return data as any
}`,
    }

    const result = await typeStrictness.evaluate(vfs)
    expect(result.passed).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some(e => e.includes('any'))).toBe(true)
  })

  it('should detect @ts-ignore directives', async () => {
    const vfs = {
      'src/hack.ts': `// @ts-ignore
const x = badCall()`,
    }

    const result = await typeStrictness.evaluate(vfs)
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => e.includes('ts-ignore'))).toBe(true)
  })

  it('should detect @ts-nocheck directives', async () => {
    const vfs = {
      'src/legacy.ts': `// @ts-nocheck
const x = anything`,
    }

    const result = await typeStrictness.evaluate(vfs)
    expect(result.passed).toBe(false)
  })

  it('should skip non-TypeScript files', async () => {
    const vfs = {
      'readme.md': 'any text with any words',
      'config.json': '{ "any": true }',
    }

    const result = await typeStrictness.evaluate(vfs)
    expect(result.score).toBe(15)
  })

  it('should skip .d.ts files', async () => {
    const vfs = {
      'src/types.d.ts': `declare const x: any`,
    }

    const result = await typeStrictness.evaluate(vfs)
    expect(result.score).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// eslintClean dimension
// ---------------------------------------------------------------------------

describe('eslintClean', () => {
  it('should score full points for clean code', async () => {
    const vfs = {
      'src/service.ts': `export class Service {
  handle(): void { /* production ready */ }
}`,
    }

    const result = await eslintClean.evaluate(vfs)
    expect(result.score).toBe(10)
    expect(result.warnings).toHaveLength(0)
  })

  it('should flag console.log in source files', async () => {
    const vfs = {
      'src/handler.ts': `export function handle() {
  console.log('debug')
}`,
    }

    const result = await eslintClean.evaluate(vfs)
    expect(result.passed).toBe(false)
    expect(result.warnings.some(w => w.includes('console.log'))).toBe(true)
  })

  it('should flag debugger statements', async () => {
    const vfs = {
      'src/handler.ts': `export function handle() {
  debugger
}`,
    }

    const result = await eslintClean.evaluate(vfs)
    expect(result.warnings.some(w => w.includes('debugger'))).toBe(true)
  })

  it('should flag alert() calls', async () => {
    const vfs = {
      'src/handler.ts': `export function handle() {
  alert('oops')
}`,
    }

    const result = await eslintClean.evaluate(vfs)
    expect(result.warnings.some(w => w.includes('alert()'))).toBe(true)
  })

  it('should ignore test files', async () => {
    const vfs = {
      'src/service.test.ts': `console.log('test debug')
debugger`,
    }

    const result = await eslintClean.evaluate(vfs)
    // Test files are not source files, so they are skipped
    expect(result.warnings).toHaveLength(0)
  })

  it('should ignore files in __tests__ directories', async () => {
    const vfs = {
      'src/__tests__/helper.ts': `console.log('test helper')`,
    }

    const result = await eslintClean.evaluate(vfs)
    expect(result.warnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// hasTests dimension
// ---------------------------------------------------------------------------

describe('hasTests', () => {
  it('should score full points when all source files have tests', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/service.test.ts': 'describe("Service", () => {})',
    }

    const result = await hasTests.evaluate(vfs)
    expect(result.score).toBe(10)
    expect(result.passed).toBe(true)
  })

  it('should detect .spec.ts as test files', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/service.spec.ts': 'describe("Service", () => {})',
    }

    const result = await hasTests.evaluate(vfs)
    expect(result.passed).toBe(true)
  })

  it('should warn about missing test files', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/utils.ts': 'export function helper() {}',
    }

    const result = await hasTests.evaluate(vfs)
    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.warnings).toHaveLength(2)
  })

  it('should give partial credit for partial coverage', async () => {
    const vfs = {
      'src/service.ts': 'export class Service {}',
      'src/service.test.ts': 'describe("Service", () => {})',
      'src/utils.ts': 'export function helper() {}',
      // utils has no test
    }

    const result = await hasTests.evaluate(vfs)
    expect(result.score).toBe(5) // 50% coverage = 5/10
    expect(result.passed).toBe(false)
  })

  it('should skip index files', async () => {
    const vfs = {
      'src/index.ts': 'export * from "./service"',
      'src/service.ts': 'export class Service {}',
      'src/service.test.ts': 'describe("Service", () => {})',
    }

    const result = await hasTests.evaluate(vfs)
    expect(result.passed).toBe(true)
  })

  it('should give full score when no source files exist', async () => {
    const vfs = {
      'readme.md': 'documentation',
    }

    const result = await hasTests.evaluate(vfs)
    expect(result.score).toBe(10)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// codeCompleteness dimension
// ---------------------------------------------------------------------------

describe('codeCompleteness', () => {
  it('should score full points for complete code', async () => {
    const vfs = {
      'src/service.ts': `export class Service {
  async handle(data: string): Promise<void> {
    const result = await this.process(data)
    return result
  }
}`,
    }

    const result = await codeCompleteness.evaluate(vfs)
    expect(result.score).toBe(10)
    expect(result.passed).toBe(true)
  })

  it('should detect empty function bodies', async () => {
    const vfs = {
      'src/stub.ts': `export function doNothing() {}
export const handler = () => {}`,
    }

    const result = await codeCompleteness.evaluate(vfs)
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => e.includes('empty function body'))).toBe(true)
  })

  it('should detect TODO markers in code (not comments)', async () => {
    const vfs = {
      'src/service.ts': `export function handle() {
  const result = TODO
  return result
}`,
    }

    const result = await codeCompleteness.evaluate(vfs)
    expect(result.warnings.some(w => w.includes('TODO'))).toBe(true)
  })

  it('should detect FIXME markers in code', async () => {
    const vfs = {
      'src/service.ts': `export function handle() {
  const broken = FIXME
  return broken
}`,
    }

    const result = await codeCompleteness.evaluate(vfs)
    expect(result.warnings.some(w => w.includes('FIXME'))).toBe(true)
  })

  it('should skip TODO/FIXME in comment lines', async () => {
    const vfs = {
      'src/service.ts': `// TODO: implement later
/* FIXME: known issue */
/** @todo refactor this */
* TODO in continuation
export function handle(): string {
  return 'done'
}`,
    }

    const result = await codeCompleteness.evaluate(vfs)
    expect(result.warnings.filter(w => w.includes('TODO') || w.includes('FIXME'))).toHaveLength(0)
  })

  it('should skip test files', async () => {
    const vfs = {
      'src/service.test.ts': `function stubFn() {}
const x = () => {}`,
    }

    const result = await codeCompleteness.evaluate(vfs)
    expect(result.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// hasJsDoc dimension
// ---------------------------------------------------------------------------

describe('hasJsDoc', () => {
  it('should score full points when all exports have JSDoc', async () => {
    const vfs = {
      'src/service.ts': `/**
 * Processes data.
 */
export function processData(): void {}

/**
 * User service.
 */
export class UserService {}`,
    }

    const result = await hasJsDoc.evaluate(vfs)
    expect(result.score).toBe(5)
    expect(result.passed).toBe(true)
  })

  it('should warn about exports missing JSDoc', async () => {
    const vfs = {
      'src/service.ts': `export function noDoc(): void {}

export class NoDocClass {}`,
    }

    const result = await hasJsDoc.evaluate(vfs)
    expect(result.passed).toBe(false)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.some(w => w.includes('noDoc'))).toBe(true)
    expect(result.warnings.some(w => w.includes('NoDocClass'))).toBe(true)
  })

  it('should handle partial documentation', async () => {
    const vfs = {
      'src/service.ts': `/**
 * Documented function.
 */
export function documented(): void {}

export function undocumented(): void {}`,
    }

    const result = await hasJsDoc.evaluate(vfs)
    // 1/2 documented = 50% * 5 = round(2.5) = 3
    expect(result.score).toBe(3)
  })

  it('should give full score when no exports exist', async () => {
    const vfs = {
      'src/internal.ts': `function internalOnly(): void {}`,
    }

    const result = await hasJsDoc.evaluate(vfs)
    expect(result.score).toBe(5)
    expect(result.passed).toBe(true)
  })

  it('should skip test files', async () => {
    const vfs = {
      'src/service.test.ts': `export function testHelper(): void {}`,
    }

    const result = await hasJsDoc.evaluate(vfs)
    // Test files are not source files, so skipped entirely
    expect(result.score).toBe(5)
  })

  it('should detect JSDoc ending with */ on line before export', async () => {
    const vfs = {
      'src/service.ts': `/** Single line doc. */
export function singleLine(): void {}`,
    }

    const result = await hasJsDoc.evaluate(vfs)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// builtinDimensions integration
// ---------------------------------------------------------------------------

describe('builtinDimensions', () => {
  it('should have all 5 built-in dimensions', () => {
    expect(builtinDimensions).toHaveLength(5)
    const names = builtinDimensions.map(d => d.name)
    expect(names).toContain('typeStrictness')
    expect(names).toContain('eslintClean')
    expect(names).toContain('hasTests')
    expect(names).toContain('codeCompleteness')
    expect(names).toContain('hasJsDoc')
  })

  it('should produce a complete quality report with all dimensions', async () => {
    const scorer = new QualityScorer()
    scorer.addDimensions(builtinDimensions)

    const vfs = {
      'src/service.ts': `/**
 * Service class.
 */
export class Service {
  async handle(data: string): Promise<string> {
    return data.toUpperCase()
  }
}`,
      'src/service.test.ts': `import { Service } from './service'
describe('Service', () => { it('works', () => {}) })`,
    }

    const result = await scorer.evaluate(vfs)
    expect(result.quality).toBeGreaterThanOrEqual(50)
    expect(result.dimensions).toHaveLength(5)
    expect(result.dimensions.every(d => d.name.length > 0)).toBe(true)
  })

  it('should give low score for poor quality code', async () => {
    const scorer = new QualityScorer()
    scorer.addDimensions(builtinDimensions)

    const vfs = {
      'src/bad.ts': `export function hack(x: any): any {
  // @ts-ignore
  console.log('debug')
  debugger
  const stub = () => {}
  return eval(x)
}`,
    }

    const result = await scorer.evaluate(vfs)
    expect(result.quality).toBeLessThan(80)
    expect(result.success).toBe(false)
  })
})
