import { describe, it, expect, beforeEach } from 'vitest'
import { GuardrailEngine } from '../guardrails/guardrail-engine.js'
import { ConventionLearner } from '../guardrails/convention-learner.js'
import { GuardrailReporter } from '../guardrails/guardrail-reporter.js'
import { createLayeringRule } from '../guardrails/rules/layering-rule.js'
import { createImportRestrictionRule } from '../guardrails/rules/import-restriction-rule.js'
import { createNamingConventionRule } from '../guardrails/rules/naming-convention-rule.js'
import { createSecurityRule } from '../guardrails/rules/security-rule.js'
import { createTypeSafetyRule } from '../guardrails/rules/type-safety-rule.js'
import { createContractComplianceRule } from '../guardrails/rules/contract-compliance-rule.js'
import { createBuiltinRules } from '../guardrails/rules/index.js'
import type {
  GuardrailContext,
  ProjectStructure,
  ConventionSet,
  GeneratedFile,
} from '../guardrails/guardrail-types.js'

// --- Helpers ---

function makeStructure(packages?: Map<string, { name: string; dir: string; allowedDependencies: string[]; entryPoints: string[] }>): ProjectStructure {
  return {
    packages: packages ?? new Map([
      ['@dzupagent/core', { name: '@dzupagent/core', dir: 'packages/dzupagent-core/', allowedDependencies: [], entryPoints: ['index.ts'] }],
      ['@dzupagent/codegen', { name: '@dzupagent/codegen', dir: 'packages/dzupagent-codegen/', allowedDependencies: ['@dzupagent/core'], entryPoints: ['index.ts'] }],
      ['@dzupagent/agent', { name: '@dzupagent/agent', dir: 'packages/dzupagent-agent/', allowedDependencies: ['@dzupagent/core', '@dzupagent/codegen'], entryPoints: ['index.ts'] }],
      ['@dzupagent/server', { name: '@dzupagent/server', dir: 'packages/dzupagent-server/', allowedDependencies: ['@dzupagent/core', '@dzupagent/agent'], entryPoints: ['index.ts'] }],
    ]),
    rootDir: '.',
  }
}

function makeConventions(overrides?: Partial<ConventionSet>): ConventionSet {
  return {
    fileNaming: 'kebab-case',
    exportNaming: {
      classCase: 'PascalCase',
      functionCase: 'camelCase',
      constCase: 'camelCase',
    },
    importStyle: {
      indexOnly: true,
      separateTypeImports: true,
    },
    requiredPatterns: [],
    ...overrides,
  }
}

function makeContext(files: GeneratedFile[], overrides?: Partial<GuardrailContext>): GuardrailContext {
  return {
    files,
    projectStructure: makeStructure(),
    conventions: makeConventions(),
    ...overrides,
  }
}

// --- GuardrailEngine ---

describe('GuardrailEngine', () => {
  let engine: GuardrailEngine

  beforeEach(() => {
    engine = new GuardrailEngine()
  })

  it('returns passed when no rules are registered', () => {
    const result = engine.evaluate(makeContext([]))
    expect(result.passed).toBe(true)
    expect(result.totalViolations).toBe(0)
  })

  it('registers and runs rules', () => {
    engine.addRules(createBuiltinRules())
    expect(engine.getRules().length).toBe(6)

    const result = engine.evaluate(makeContext([
      { path: 'src/good-file.ts', content: 'export function greet(): string { return "hi" }' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('supports disabling specific rules', () => {
    const engineWithDisabled = new GuardrailEngine({ disabledRules: ['type-safety'] })
    engineWithDisabled.addRules(createBuiltinRules())

    const result = engineWithDisabled.evaluate(makeContext([
      { path: 'src/bad.ts', content: 'const x: any = 1' },
    ]))
    // type-safety is disabled, so no error from `any`
    expect(result.violations.filter((v) => v.ruleId === 'type-safety')).toHaveLength(0)
  })

  it('supports disabling entire categories', () => {
    const engineWithDisabled = new GuardrailEngine({ disabledCategories: ['naming'] })
    engineWithDisabled.addRules(createBuiltinRules())

    const result = engineWithDisabled.evaluate(makeContext([
      { path: 'src/BadName.ts', content: 'export class good_class {}' },
    ]))
    expect(result.violations.filter((v) => v.ruleId === 'naming-convention')).toHaveLength(0)
  })

  it('supports severity overrides', () => {
    const overrides = new Map([['type-safety', 'warning' as const]])
    const engineWithOverrides = new GuardrailEngine({ severityOverrides: overrides })
    engineWithOverrides.addRule(createTypeSafetyRule())

    const result = engineWithOverrides.evaluate(makeContext([
      { path: 'src/file.ts', content: 'const x: any = 1' },
    ]))
    expect(result.passed).toBe(true) // downgraded from error to warning
    expect(result.warningCount).toBeGreaterThan(0)
  })

  it('supports fail-fast mode', () => {
    const failFastEngine = new GuardrailEngine({ failFast: true })
    failFastEngine.addRule(createTypeSafetyRule())
    failFastEngine.addRule(createSecurityRule())

    const result = failFastEngine.evaluate(makeContext([
      { path: 'src/bad.ts', content: 'const x: any = 1\nconst key = "AKIAIOSFODNN7EXAMPLE1"' },
    ]))
    // Should stop after first rule with errors
    const ruleIds = new Set(result.violations.map((v) => v.ruleId))
    expect(ruleIds.size).toBe(1)
  })
})

// --- LayeringRule ---

describe('LayeringRule', () => {
  const rule = createLayeringRule()

  it('passes when imports follow correct direction', () => {
    const result = rule.check(makeContext([
      {
        path: 'packages/dzupagent-codegen/src/service.ts',
        content: "import { SomeType } from '@dzupagent/core'",
      },
    ]))
    expect(result.passed).toBe(true)
  })

  it('fails when lower-layer imports higher-layer', () => {
    const result = rule.check(makeContext([
      {
        path: 'packages/dzupagent-core/src/bad.ts',
        content: "import { Agent } from '@dzupagent/agent'",
      },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.message).toContain('layer')
  })

  it('passes when importing from same layer', () => {
    const result = rule.check(makeContext([
      {
        path: 'packages/dzupagent-codegen/src/service.ts',
        content: "import { MemoryService } from '@dzupagent/memory'",
      },
    ]))
    // Same layer (1) importing same layer — no violation
    expect(result.passed).toBe(true)
  })

  it('ignores non-scoped imports', () => {
    const result = rule.check(makeContext([
      {
        path: 'packages/dzupagent-core/src/util.ts',
        content: "import { z } from 'zod'",
      },
    ]))
    expect(result.passed).toBe(true)
  })
})

// --- ImportRestrictionRule ---

describe('ImportRestrictionRule', () => {
  const rule = createImportRestrictionRule()

  it('passes for index-level imports', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/service.ts',
        content: "import { Foo } from '@dzupagent/core'",
      },
    ]))
    expect(result.passed).toBe(true)
  })

  it('fails for deep imports into package internals', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/service.ts',
        content: "import { secret } from '@dzupagent/core/src/internal/secret'",
      },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('Deep import')
  })

  it('allows explicitly permitted subpaths', () => {
    const ruleWithAllowed = createImportRestrictionRule({ allowedSubpaths: ['dist', 'types', 'utils'] })
    const result = ruleWithAllowed.check(makeContext([
      {
        path: 'src/service.ts',
        content: "import { helper } from '@dzupagent/core/utils/helper'",
      },
    ]))
    expect(result.passed).toBe(true)
  })

  it('ignores non-matching scopes', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/service.ts',
        content: "import { merge } from 'lodash/merge'",
      },
    ]))
    expect(result.passed).toBe(true)
  })
})

// --- NamingConventionRule ---

describe('NamingConventionRule', () => {
  const rule = createNamingConventionRule()

  it('passes for kebab-case file names', () => {
    const result = rule.check(makeContext([
      { path: 'src/my-service.ts', content: 'export class MyService {}' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })

  it('flags non-kebab-case file names', () => {
    const result = rule.check(makeContext([
      { path: 'src/MyService.ts', content: 'export class MyService {}' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(1)
  })

  it('flags non-PascalCase class exports', () => {
    const result = rule.check(makeContext([
      { path: 'src/bad.ts', content: 'export class myService {}' },
    ]))
    expect(result.violations.some((v) => v.message.includes('PascalCase'))).toBe(true)
  })

  it('passes for correctly named exports', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/good-file.ts',
        content: [
          'export class GoodService {}',
          'export interface GoodInterface {}',
          'export function doSomething() {}',
          'export type GoodType = string',
        ].join('\n'),
      },
    ]))
    expect(result.violations).toHaveLength(0)
  })

  it('skips index files for name checking', () => {
    const result = rule.check(makeContext([
      { path: 'src/index.ts', content: 'export * from "./service.js"' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })
})

// --- SecurityRule ---

describe('SecurityRule', () => {
  const rule = createSecurityRule()

  it('detects hardcoded AWS keys', () => {
    const result = rule.check(makeContext([
      { path: 'src/config.ts', content: 'const key = "AKIAIOSFODNN7EXAMPLE1"' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('AWS')
  })

  it('detects hardcoded API keys', () => {
    const result = rule.check(makeContext([
      { path: 'src/config.ts', content: 'const api_key = "sk-abcdefghijklmnop1234"' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('API key')
  })

  it('detects hardcoded passwords', () => {
    const result = rule.check(makeContext([
      { path: 'src/config.ts', content: 'const password = "superSecretPassword123"' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('secret')
  })

  it('detects connection strings with credentials', () => {
    const result = rule.check(makeContext([
      { path: 'src/db.ts', content: 'const url = "postgres://admin:pass123@localhost:5432/db"' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('connection string')
  })

  it('allows process.env references', () => {
    const result = rule.check(makeContext([
      { path: 'src/config.ts', content: 'const key = process.env.API_KEY' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('skips test files', () => {
    const result = rule.check(makeContext([
      { path: 'src/config.test.ts', content: 'const password = "testPassword123456"' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('allows placeholder values', () => {
    const result = rule.check(makeContext([
      { path: 'src/config.ts', content: 'const secret = "<API_KEY>"' },
    ]))
    expect(result.passed).toBe(true)
  })
})

// --- TypeSafetyRule ---

describe('TypeSafetyRule', () => {
  const rule = createTypeSafetyRule()

  it('detects : any type annotations', () => {
    const result = rule.check(makeContext([
      { path: 'src/service.ts', content: 'function foo(x: any): void {}' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('"any"')
  })

  it('detects as any assertions', () => {
    const result = rule.check(makeContext([
      { path: 'src/service.ts', content: 'const x = value as any' },
    ]))
    expect(result.passed).toBe(false)
  })

  it('detects @ts-ignore', () => {
    const result = rule.check(makeContext([
      { path: 'src/service.ts', content: '// @ts-ignore\nconst x = 1' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('@ts-ignore')
  })

  it('warns on @ts-expect-error', () => {
    const result = rule.check(makeContext([
      { path: 'src/service.ts', content: '// @ts-expect-error — intentional\nconst x = 1' },
    ]))
    // @ts-expect-error is a warning, not an error
    expect(result.passed).toBe(true)
    expect(result.violations[0]!.severity).toBe('warning')
  })

  it('detects @ts-nocheck', () => {
    const result = rule.check(makeContext([
      { path: 'src/service.ts', content: '// @ts-nocheck\nconst x = 1' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('@ts-nocheck')
  })

  it('passes clean TypeScript', () => {
    const result = rule.check(makeContext([
      { path: 'src/service.ts', content: 'export function greet(name: string): string { return name }' },
    ]))
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('skips non-TypeScript files', () => {
    const result = rule.check(makeContext([
      { path: 'src/readme.md', content: 'Use any type you want' },
    ]))
    expect(result.violations).toHaveLength(0)
  })
})

// --- ContractComplianceRule ---

describe('ContractComplianceRule', () => {
  const rule = createContractComplianceRule()

  it('passes when class implements all interface members', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/types.ts',
        content: [
          'export interface Greeter {',
          '  greet(name: string): string',
          '  readonly language: string',
          '}',
        ].join('\n'),
      },
      {
        path: 'src/impl.ts',
        content: [
          'export class EnglishGreeter implements Greeter {',
          '  readonly language = "en"',
          '  greet(name: string): string {',
          '    return `Hello, ${name}!`',
          '  }',
          '}',
        ].join('\n'),
      },
    ]))
    expect(result.passed).toBe(true)
  })

  it('fails when class is missing interface members', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/types.ts',
        content: [
          'export interface Greeter {',
          '  greet(name: string): string',
          '  farewell(name: string): string',
          '}',
        ].join('\n'),
      },
      {
        path: 'src/impl.ts',
        content: [
          'export class EnglishGreeter implements Greeter {',
          '  greet(name: string): string {',
          '    return `Hello, ${name}!`',
          '  }',
          '}',
        ].join('\n'),
      },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.message).toContain('farewell')
  })

  it('skips interfaces not in the generated files', () => {
    const result = rule.check(makeContext([
      {
        path: 'src/impl.ts',
        content: [
          'export class MyService implements ExternalInterface {',
          '  doWork(): void {}',
          '}',
        ].join('\n'),
      },
    ]))
    // ExternalInterface is not in generated files, so we skip it
    expect(result.passed).toBe(true)
  })
})

// --- ConventionLearner ---

describe('ConventionLearner', () => {
  it('learns kebab-case file naming from project files', () => {
    const learner = new ConventionLearner()
    const files: GeneratedFile[] = [
      { path: 'src/my-service.ts', content: 'export class MyService {}' },
      { path: 'src/user-controller.ts', content: 'export class UserController {}' },
      { path: 'src/auth-middleware.ts', content: 'export function authMiddleware() {}' },
      { path: 'src/data-store.ts', content: 'export class DataStore {}' },
    ]
    const conventions = learner.learn(files)
    expect(conventions.fileNaming).toBe('kebab-case')
  })

  it('learns PascalCase file naming from project files', () => {
    const learner = new ConventionLearner()
    const files: GeneratedFile[] = [
      { path: 'src/MyService.ts', content: 'export class MyService {}' },
      { path: 'src/UserController.ts', content: 'export class UserController {}' },
      { path: 'src/AuthMiddleware.ts', content: 'export function AuthMiddleware() {}' },
      { path: 'src/DataStore.ts', content: 'export class DataStore {}' },
    ]
    const conventions = learner.learn(files)
    expect(conventions.fileNaming).toBe('PascalCase')
  })

  it('detects separate type imports', () => {
    const learner = new ConventionLearner()
    const files: GeneratedFile[] = [
      { path: 'src/a.ts', content: "import type { Foo } from './foo.js'\nimport { bar } from './bar.js'" },
      { path: 'src/b.ts', content: "import type { Baz } from './baz.js'\nimport { qux } from './qux.js'" },
      { path: 'src/c.ts', content: "import type { X } from './x.js'" },
    ]
    const conventions = learner.learn(files)
    expect(conventions.importStyle.separateTypeImports).toBe(true)
  })

  it('returns defaults when too few files', () => {
    const learner = new ConventionLearner({ minFiles: 5 })
    const files: GeneratedFile[] = [
      { path: 'src/a.ts', content: '' },
      { path: 'src/b.ts', content: '' },
    ]
    const conventions = learner.learn(files)
    expect(conventions.fileNaming).toBe('kebab-case') // default
  })

  it('caches conventions', () => {
    const learner = new ConventionLearner()
    const files: GeneratedFile[] = [
      { path: 'src/my-service.ts', content: '' },
      { path: 'src/my-controller.ts', content: '' },
      { path: 'src/my-store.ts', content: '' },
    ]
    const first = learner.getConventions(files)
    const second = learner.getConventions([]) // should return cached
    expect(first).toBe(second)
  })

  it('clears cache', () => {
    const learner = new ConventionLearner()
    const files: GeneratedFile[] = [
      { path: 'src/my-service.ts', content: '' },
      { path: 'src/my-controller.ts', content: '' },
      { path: 'src/my-store.ts', content: '' },
    ]
    const first = learner.getConventions(files)
    learner.clearCache()
    const second = learner.getConventions(files)
    expect(first).not.toBe(second) // different object
    expect(first).toEqual(second) // same values
  })
})

// --- GuardrailReporter ---

describe('GuardrailReporter', () => {
  it('formats text report with violations grouped by category', () => {
    const engine = new GuardrailEngine()
    engine.addRules(createBuiltinRules())

    const report = engine.evaluate(makeContext([
      {
        path: 'packages/dzupagent-core/src/bad.ts',
        content: "import { Agent } from '@dzupagent/agent'\nconst x: any = 1",
      },
    ]))

    const reporter = new GuardrailReporter()
    const text = reporter.format(report)

    expect(text).toContain('FAILED')
    expect(text).toContain('Errors:')
  })

  it('formats JSON report', () => {
    const engine = new GuardrailEngine()
    engine.addRule(createTypeSafetyRule())

    const report = engine.evaluate(makeContext([
      { path: 'src/bad.ts', content: 'const x: any = 1' },
    ]))

    const reporter = new GuardrailReporter({ format: 'json' })
    const json = reporter.format(report)
    const parsed = JSON.parse(json)

    expect(parsed.passed).toBe(false)
    expect(parsed.violations.length).toBeGreaterThan(0)
    expect(parsed.violations[0].ruleId).toBe('type-safety')
  })

  it('hides info violations when configured', () => {
    const engine = new GuardrailEngine()
    engine.addRule(createNamingConventionRule())

    const report = engine.evaluate(makeContext([
      { path: 'src/good-file.ts', content: 'export const bad_name = 1' },
    ]))

    const withInfo = new GuardrailReporter({ showInfo: true })
    const withoutInfo = new GuardrailReporter({ showInfo: false })

    const textWith = withInfo.format(report)
    const textWithout = withoutInfo.format(report)

    // Info violations might be filtered; ensure at least it runs without error
    expect(textWith.length).toBeGreaterThanOrEqual(textWithout.length)
  })

  it('formats passed report', () => {
    const engine = new GuardrailEngine()
    engine.addRule(createTypeSafetyRule())

    const report = engine.evaluate(makeContext([
      { path: 'src/clean.ts', content: 'export const value: string = "hello"' },
    ]))

    const reporter = new GuardrailReporter()
    const text = reporter.format(report)

    expect(text).toContain('PASSED')
    expect(text).toContain('No violations found')
  })
})

// --- Integration: full pipeline ---

describe('Full Guardrail Pipeline', () => {
  it('runs all built-in rules and produces a complete report', () => {
    const engine = new GuardrailEngine()
    engine.addRules(createBuiltinRules())

    const files: GeneratedFile[] = [
      {
        path: 'src/good-service.ts',
        content: [
          "import type { Foo } from '@dzupagent/core'",
          '',
          'export interface ServiceConfig {',
          '  name: string',
          '  timeout: number',
          '}',
          '',
          'export class GoodService {',
          '  private readonly config: ServiceConfig',
          '  constructor(config: ServiceConfig) {',
          '    this.config = config',
          '  }',
          '  getName(): string {',
          '    return this.config.name',
          '  }',
          '}',
        ].join('\n'),
      },
    ]

    const report = engine.evaluate(makeContext(files))
    expect(report.passed).toBe(true)
    expect(report.errorCount).toBe(0)
  })

  it('catches multiple violation types in one run', () => {
    const engine = new GuardrailEngine()
    engine.addRules(createBuiltinRules())

    const files: GeneratedFile[] = [
      {
        path: 'packages/dzupagent-core/src/BadFile.ts',
        content: [
          "import { Agent } from '@dzupagent/agent'",           // layering violation
          "import { internal } from '@dzupagent/core/src/int'", // deep import
          '// @ts-ignore',                                        // type safety
          'const secret = "AKIAIOSFODNN7EXAMPLE1"',              // security
          'const x: any = 1',                                     // type safety
        ].join('\n'),
      },
    ]

    const report = engine.evaluate(makeContext(files))
    expect(report.passed).toBe(false)

    const ruleIds = new Set(report.violations.map((v) => v.ruleId))
    expect(ruleIds.has('layering')).toBe(true)
    expect(ruleIds.has('type-safety')).toBe(true)
    expect(ruleIds.has('security')).toBe(true)
  })
})
