import { describe, it, expect } from 'vitest'
import { ConventionGate } from '../quality/convention-gate.js'
import type { LearnedConvention, ConventionGateResult } from '../quality/convention-gate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function file(path: string, content: string) {
  return { path, content }
}

// ---------------------------------------------------------------------------
// Default conventions — violation detection
// ---------------------------------------------------------------------------

describe('ConventionGate — default conventions', () => {
  const gate = ConventionGate.withDefaults()

  it('should detect `any` type usage', () => {
    const result = gate.evaluate([
      file('src/bad.ts', 'export function handle(x: any): any { return x as any }'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(1)
    expect(result.violations.some((v) => v.convention.includes('any'))).toBe(true)
  })

  it('should detect @ts-ignore', () => {
    const result = gate.evaluate([
      file('src/hack.ts', '// @ts-ignore\nconst x = bad()'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('ts-ignore'))).toBe(true)
  })

  it('should detect @ts-nocheck', () => {
    const result = gate.evaluate([
      file('src/legacy.ts', '// @ts-nocheck\nconst x = anything'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('ts-ignore'))).toBe(true)
  })

  it('should detect console.log in production files', () => {
    const result = gate.evaluate([
      file('src/handler.ts', 'export function handle() {\n  console.log("debug")\n}'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('console.log'))).toBe(true)
  })

  it('should allow console.log in test files', () => {
    const result = gate.evaluate([
      file('src/handler.test.ts', 'console.log("test debug")'),
    ])

    const consoleViolations = result.violations.filter((v) =>
      v.convention.includes('console.log'),
    )
    expect(consoleViolations).toHaveLength(0)
  })

  it('should detect var declarations', () => {
    const result = gate.evaluate([
      file('src/old.ts', 'var count = 0'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('var'))).toBe(true)
  })

  it('should detect non-kebab-case file names', () => {
    const result = gate.evaluate([
      file('src/MyService.ts', 'export class MyService {}'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('kebab'))).toBe(true)
  })

  it('should allow kebab-case file names', () => {
    const result = gate.evaluate([
      file('src/my-service.ts', 'export class MyService {}'),
    ])

    const namingViolations = result.violations.filter((v) =>
      v.convention.includes('kebab'),
    )
    expect(namingViolations).toHaveLength(0)
  })

  it('should allow index.ts files', () => {
    const result = gate.evaluate([
      file('src/index.ts', 'export { MyService } from "./my-service.js"'),
    ])

    const namingViolations = result.violations.filter((v) =>
      v.convention.includes('kebab'),
    )
    expect(namingViolations).toHaveLength(0)
  })

  it('should detect relative imports missing .js extension', () => {
    const result = gate.evaluate([
      file('src/main.ts', "import { Foo } from './foo'"),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('ESM'))).toBe(true)
  })

  it('should allow relative imports with .js extension', () => {
    const result = gate.evaluate([
      file('src/main.ts', "import { Foo } from './foo.js'"),
    ])

    const esmViolations = result.violations.filter((v) =>
      v.convention.includes('ESM'),
    )
    expect(esmViolations).toHaveLength(0)
  })

  it('should detect non-PascalCase exported class names', () => {
    const result = gate.evaluate([
      file('src/bad-class.ts', 'export class myService {}'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('PascalCase'))).toBe(true)
  })

  it('should detect non-camelCase exported function names', () => {
    const result = gate.evaluate([
      file('src/bad-func.ts', 'export function MyFunction() {}'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.convention.includes('camelCase'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Clean code passes all conventions
// ---------------------------------------------------------------------------

describe('ConventionGate — clean code', () => {
  const gate = ConventionGate.withDefaults()

  it('should pass for clean, convention-compliant code', () => {
    const result = gate.evaluate([
      file(
        'src/user-service.ts',
        [
          "import type { User } from './user-types.js'",
          '',
          '/**',
          ' * Handles user operations.',
          ' */',
          'export class UserService {',
          '  async getUser(id: string): Promise<User | null> {',
          '    const user = await this.findById(id)',
          '    return user',
          '  }',
          '',
          '  private async findById(_id: string): Promise<User | null> {',
          '    return null',
          '  }',
          '}',
          '',
          'export function createUserService(): UserService {',
          '  return new UserService()',
          '}',
        ].join('\n'),
      ),
    ])

    expect(result.passed).toBe(true)
    expect(result.errorsCount).toBe(0)
    expect(result.violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Confidence filtering
// ---------------------------------------------------------------------------

describe('ConventionGate — confidence filtering', () => {
  it('should skip conventions below minConfidence', () => {
    const lowConfidence: LearnedConvention = {
      id: 'low-conf',
      name: 'Low confidence rule',
      description: 'This is a low-confidence convention',
      pattern: /TODO/,
      category: 'style',
      confidence: 0.3,
    }

    const gate = new ConventionGate({
      conventions: [lowConfidence],
      minConfidence: 0.7,
    })

    const result = gate.evaluate([
      file('src/service.ts', '// TODO: implement this'),
    ])

    expect(result.passed).toBe(true)
    expect(result.conventionsChecked).toBe(0)
    expect(result.violations).toHaveLength(0)
  })

  it('should enforce conventions at or above minConfidence', () => {
    const highConfidence: LearnedConvention = {
      id: 'high-conf',
      name: 'High confidence rule',
      description: 'This is a high-confidence convention',
      pattern: /TODO/,
      category: 'style',
      confidence: 0.9,
    }

    const gate = new ConventionGate({
      conventions: [highConfidence],
      minConfidence: 0.7,
    })

    const result = gate.evaluate([
      file('src/service.ts', '// TODO: implement this'),
    ])

    expect(result.passed).toBe(false)
    expect(result.conventionsChecked).toBe(1)
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it('should use default minConfidence of 0.7', () => {
    const borderline: LearnedConvention = {
      id: 'border',
      name: 'Borderline rule',
      description: 'Exactly 0.7 confidence',
      pattern: /FIXME/,
      category: 'style',
      confidence: 0.7,
    }

    const gate = new ConventionGate({ conventions: [borderline] })

    const result = gate.evaluate([
      file('src/service.ts', '// FIXME: fix this'),
    ])

    expect(result.conventionsChecked).toBe(1)
    expect(result.violations.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// warningsOnly mode
// ---------------------------------------------------------------------------

describe('ConventionGate — warningsOnly', () => {
  it('should treat all violations as warnings when warningsOnly is true', () => {
    const gate = ConventionGate.withDefaults({ warningsOnly: true })

    const result = gate.evaluate([
      file('src/bad.ts', 'export function handle(x: any) { var y = x; console.log(y) }'),
    ])

    // All violations are warnings, so the gate passes
    expect(result.passed).toBe(true)
    expect(result.errorsCount).toBe(0)
    expect(result.warningsCount).toBeGreaterThan(0)
    expect(result.violations.every((v) => v.severity === 'warning')).toBe(true)
  })

  it('should fail when warningsOnly is false (default)', () => {
    const gate = ConventionGate.withDefaults()

    const result = gate.evaluate([
      file('src/bad.ts', 'export function handle(x: any) {}'),
    ])

    expect(result.passed).toBe(false)
    expect(result.errorsCount).toBeGreaterThan(0)
    expect(result.violations.some((v) => v.severity === 'error')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Custom conventions
// ---------------------------------------------------------------------------

describe('ConventionGate — custom conventions', () => {
  it('should support custom test function conventions', () => {
    const noDefaultExport: LearnedConvention = {
      id: 'no-default-export',
      name: 'No default exports',
      description: 'Prefer named exports over default exports',
      category: 'exports',
      confidence: 0.9,
      test: (content: string): boolean => {
        return !/\bexport\s+default\b/.test(content)
      },
    }

    const gate = new ConventionGate({ conventions: [noDefaultExport] })

    const passing = gate.evaluate([
      file('src/service.ts', 'export class Service {}'),
    ])
    expect(passing.passed).toBe(true)

    const failing = gate.evaluate([
      file('src/service.ts', 'export default class Service {}'),
    ])
    expect(failing.passed).toBe(false)
    expect(failing.violations[0]?.convention).toBe('No default exports')
  })

  it('should support custom regex pattern conventions', () => {
    const noEval: LearnedConvention = {
      id: 'no-eval',
      name: 'No eval()',
      description: 'Never use eval() for security reasons',
      category: 'security',
      confidence: 0.99,
      pattern: /\beval\s*\(/,
    }

    const gate = new ConventionGate({ conventions: [noEval] })

    const result = gate.evaluate([
      file('src/handler.ts', 'const result = eval("code")'),
    ])

    expect(result.passed).toBe(false)
    expect(result.violations[0]?.line).toBe(1)
  })

  it('should support string patterns (converted to RegExp)', () => {
    const noAlert: LearnedConvention = {
      id: 'no-alert',
      name: 'No alert()',
      description: 'Do not use alert() in production',
      category: 'style',
      confidence: 0.8,
      pattern: '\\balert\\s*\\(',
    }

    const gate = new ConventionGate({ conventions: [noAlert] })

    const result = gate.evaluate([
      file('src/ui.ts', 'alert("error")'),
    ])

    expect(result.passed).toBe(false)
  })

  it('should merge custom conventions with defaults via withDefaults', () => {
    const custom: LearnedConvention = {
      id: 'custom-rule',
      name: 'Custom rule',
      description: 'A project-specific rule',
      category: 'other',
      confidence: 0.9,
      pattern: /HACK/,
    }

    const gate = ConventionGate.withDefaults({ conventions: [custom] })

    // Built-in conventions + 1 custom
    const result = gate.evaluate([
      file('src/service.ts', '// HACK: workaround'),
    ])

    expect(result.conventionsChecked).toBeGreaterThan(1)
    expect(result.violations.some((v) => v.convention === 'Custom rule')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

describe('ConventionGate — multiple files', () => {
  const gate = ConventionGate.withDefaults()

  it('should check all files and aggregate violations', () => {
    const result = gate.evaluate([
      file('src/good.ts', 'export function doStuff(): void {}'),
      file('src/bad.ts', 'export function handle(x: any) {}'),
      file('src/also-bad.ts', 'var x = 1; console.log(x)'),
    ])

    expect(result.passed).toBe(false)
    // Violations from bad.ts and also-bad.ts
    const badFiles = new Set(result.violations.map((v) => v.file))
    expect(badFiles.has('src/bad.ts')).toBe(true)
    expect(badFiles.has('src/also-bad.ts')).toBe(true)
  })

  it('should pass when all files are clean', () => {
    const result = gate.evaluate([
      file('src/service-a.ts', "import { B } from './service-b.js'\nexport class ServiceA { use(_b: B): void {} }"),
      file('src/service-b.ts', 'export class ServiceB {}'),
    ])

    expect(result.passed).toBe(true)
    expect(result.errorsCount).toBe(0)
  })

  it('should handle empty file list', () => {
    const result = gate.evaluate([])

    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.conventionsChecked).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Result counts
// ---------------------------------------------------------------------------

describe('ConventionGate — result counts', () => {
  it('should accurately count errors and warnings', () => {
    const errorConvention: LearnedConvention = {
      id: 'err',
      name: 'Error convention',
      description: 'Causes errors',
      category: 'security',
      confidence: 0.9,
      pattern: /BAD/,
    }
    const warnConvention: LearnedConvention = {
      id: 'warn',
      name: 'Warn convention',
      description: 'Causes warnings',
      category: 'style',
      confidence: 0.9,
      pattern: /WARN/,
    }

    const gate = new ConventionGate({
      conventions: [errorConvention, warnConvention],
      warningsOnly: false,
    })

    const result = gate.evaluate([
      file('src/mixed.ts', 'BAD line\nWARN line\nBAD again'),
    ])

    // Both patterns produce errors (warningsOnly is false)
    expect(result.errorsCount).toBe(3)
    expect(result.warningsCount).toBe(0)
    expect(result.violations).toHaveLength(3)
  })

  it('should report conventionsChecked accurately', () => {
    const conventions: LearnedConvention[] = [
      { id: 'a', name: 'A', description: 'A', category: 'style', confidence: 0.9, pattern: /A/ },
      { id: 'b', name: 'B', description: 'B', category: 'style', confidence: 0.5, pattern: /B/ },
      { id: 'c', name: 'C', description: 'C', category: 'style', confidence: 0.8, pattern: /C/ },
    ]

    const gate = new ConventionGate({ conventions, minConfidence: 0.7 })
    const result = gate.evaluate([file('src/x.ts', 'hello')])

    // Only A (0.9) and C (0.8) meet the 0.7 threshold
    expect(result.conventionsChecked).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Non-TS files
// ---------------------------------------------------------------------------

describe('ConventionGate — non-TypeScript files', () => {
  const gate = ConventionGate.withDefaults()

  it('should skip pattern checks on non-TS files', () => {
    const result = gate.evaluate([
      file('README.md', 'Use any approach you like. var x = 1. console.log(x)'),
    ])

    // Pattern-based conventions skip non-TS files
    // Test-based conventions also check isTypeScriptFile
    expect(result.passed).toBe(true)
  })

  it('should skip file naming check on non-TS files', () => {
    const result = gate.evaluate([
      file('MyConfig.json', '{}'),
    ])

    const namingViolations = result.violations.filter((v) =>
      v.convention.includes('kebab'),
    )
    expect(namingViolations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Violation details
// ---------------------------------------------------------------------------

describe('ConventionGate — violation structure', () => {
  it('should include line numbers for pattern-based violations', () => {
    const gate = ConventionGate.withDefaults()
    const result = gate.evaluate([
      file('src/bad.ts', 'const x = 1\nvar y = 2\nconst z = 3'),
    ])

    const varViolation = result.violations.find((v) => v.convention.includes('var'))
    expect(varViolation).toBeDefined()
    expect(varViolation?.line).toBe(2)
    expect(varViolation?.file).toBe('src/bad.ts')
    expect(varViolation?.suggestion).toBeDefined()
  })

  it('should include convention name and description in violations', () => {
    const gate = ConventionGate.withDefaults()
    const result = gate.evaluate([
      file('src/bad.ts', 'export function handle(x: any) {}'),
    ])

    const violation = result.violations[0]
    expect(violation?.convention).toBeTruthy()
    expect(violation?.description).toBeTruthy()
  })
})
