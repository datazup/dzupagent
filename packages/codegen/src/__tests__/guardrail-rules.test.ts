import { describe, it, expect } from 'vitest'
import { createSecurityRule } from '../guardrails/rules/security-rule.js'
import { createImportRestrictionRule } from '../guardrails/rules/import-restriction-rule.js'
import { createNamingConventionRule } from '../guardrails/rules/naming-convention-rule.js'
import { createTypeSafetyRule } from '../guardrails/rules/type-safety-rule.js'
import { createLayeringRule } from '../guardrails/rules/layering-rule.js'
import { createContractComplianceRule } from '../guardrails/rules/contract-compliance-rule.js'
import type {
  GuardrailContext,
  ProjectStructure,
  ConventionSet,
  GeneratedFile,
} from '../guardrails/guardrail-types.js'

// --- Helpers ---------------------------------------------------------------

function makeStructure(): ProjectStructure {
  return {
    packages: new Map([
      ['@dzupagent/core', { name: '@dzupagent/core', dir: 'packages/core/', allowedDependencies: [], entryPoints: ['index.ts'] }],
      ['@dzupagent/codegen', { name: '@dzupagent/codegen', dir: 'packages/codegen/', allowedDependencies: ['@dzupagent/core'], entryPoints: ['index.ts'] }],
      ['@dzupagent/agent', { name: '@dzupagent/agent', dir: 'packages/agent/', allowedDependencies: ['@dzupagent/core', '@dzupagent/codegen'], entryPoints: ['index.ts'] }],
      ['@dzupagent/server', { name: '@dzupagent/server', dir: 'packages/server/', allowedDependencies: ['@dzupagent/core', '@dzupagent/agent'], entryPoints: ['index.ts'] }],
    ]),
    rootDir: '.',
  }
}

function makeConventions(overrides?: Partial<ConventionSet>): ConventionSet {
  return {
    fileNaming: 'kebab-case',
    exportNaming: { classCase: 'PascalCase', functionCase: 'camelCase', constCase: 'camelCase' },
    importStyle: { indexOnly: true, separateTypeImports: true },
    requiredPatterns: [],
    ...overrides,
  }
}

function ctx(files: GeneratedFile[], overrides?: Partial<GuardrailContext>): GuardrailContext {
  return {
    files,
    projectStructure: makeStructure(),
    conventions: makeConventions(),
    ...overrides,
  }
}

// ===========================================================================
// SecurityRule
// ===========================================================================

describe('SecurityRule', () => {
  const rule = createSecurityRule()

  // --- metadata ---
  it('has correct id and category', () => {
    expect(rule.id).toBe('security')
    expect(rule.category).toBe('security')
    expect(rule.severity).toBe('error')
  })

  // --- happy path ---
  it('passes for code with no secrets', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: 'export function greet(): string { return "hello" }' },
    ]))
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('passes when secret-like values come from env', () => {
    const result = rule.check(ctx([
      { path: 'src/config.ts', content: 'const key = process.env.API_KEY' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('passes for import.meta.env references', () => {
    const result = rule.check(ctx([
      { path: 'src/config.ts', content: 'const key = import.meta.env.VITE_API_KEY' },
    ]))
    expect(result.passed).toBe(true)
  })

  // --- violations ---
  it('detects hardcoded GitHub token', () => {
    const result = rule.check(ctx([
      { path: 'src/config.ts', content: 'const ghToken: string = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"' },
    ]))
    expect(result.passed).toBe(false)
    // May match generic-secret first (because of the `token` keyword), which is still correct
    expect(result.violations).toHaveLength(1)
  })

  it('detects Slack token', () => {
    const result = rule.check(ctx([
      { path: 'src/config.ts', content: 'getSlack("xoxb-123456789012-abcdefg")' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('Slack token')
  })

  it('detects private key blocks', () => {
    const result = rule.check(ctx([
      { path: 'src/certs.ts', content: 'const pk = `-----BEGIN PRIVATE KEY-----\nsome key data\n-----END PRIVATE KEY-----`' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('Private key')
  })

  it('detects JWT tokens', () => {
    const result = rule.check(ctx([
      { path: 'src/auth.ts', content: 'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('JWT')
  })

  it('detects MySQL connection string with credentials', () => {
    const result = rule.check(ctx([
      { path: 'src/db.ts', content: 'const url = "mysql://root:secret@db.example.com:3306/mydb"' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('connection string')
  })

  // --- edge cases ---
  it('skips test files entirely', () => {
    const result = rule.check(ctx([
      { path: 'src/auth.test.ts', content: 'const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('skips spec files', () => {
    const result = rule.check(ctx([
      { path: 'src/auth.spec.ts', content: 'const secret = "AKIAIOSFODNN7EXAMPLE1"' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('skips __tests__ directory', () => {
    const result = rule.check(ctx([
      { path: 'src/__tests__/auth.ts', content: 'const password = "superSecretPassword123"' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('skips fixture files', () => {
    const result = rule.check(ctx([
      { path: 'src/fixtures/mock.ts', content: 'const password = "superSecretPassword123"' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('passes for mustache placeholder values', () => {
    const result = rule.check(ctx([
      { path: 'src/config.ts', content: 'const secret = "{{SECRET_KEY}}"' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('passes for empty files', () => {
    const result = rule.check(ctx([{ path: 'src/empty.ts', content: '' }]))
    expect(result.passed).toBe(true)
  })

  it('passes for empty file list', () => {
    const result = rule.check(ctx([]))
    expect(result.passed).toBe(true)
  })

  it('reports at most one violation per line', () => {
    // A line that matches both generic-secret AND connection-string patterns
    const result = rule.check(ctx([
      { path: 'src/db.ts', content: 'const password = "postgres://admin:pass123@localhost:5432/db"' },
    ]))
    // Should have exactly 1 violation for this single line
    expect(result.violations).toHaveLength(1)
  })

  it('skips comment-only lines', () => {
    const result = rule.check(ctx([
      { path: 'src/config.ts', content: '// const key = "AKIAIOSFODNN7EXAMPLE1"' },
    ]))
    expect(result.passed).toBe(true)
  })
})

// ===========================================================================
// ImportRestrictionRule
// ===========================================================================

describe('ImportRestrictionRule', () => {
  const rule = createImportRestrictionRule()

  it('has correct id and category', () => {
    expect(rule.id).toBe('import-restriction')
    expect(rule.category).toBe('imports')
    expect(rule.severity).toBe('error')
  })

  // --- happy path ---
  it('passes for top-level scoped package import', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { Foo } from '@dzupagent/core'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('passes for index-level import', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { Foo } from '@dzupagent/core/index'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('passes for index.js import', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { Foo } from '@dzupagent/core/index.js'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('allows default permitted subpaths (dist, types)', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { Foo } from '@dzupagent/core/types/common'" },
    ]))
    expect(result.passed).toBe(true)
  })

  // --- violations ---
  it('detects deep import into src/internal', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { x } from '@dzupagent/core/src/internal/secret'" },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.message).toContain('Deep import')
    expect(result.violations[0]!.suggestion).toContain('@dzupagent/core')
  })

  it('detects deep import from src subpath', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { util } from '@dzupagent/agent/src/utils'" },
    ]))
    expect(result.passed).toBe(false)
  })

  // --- edge cases ---
  it('ignores non-scoped (bare) package imports', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { merge } from 'lodash/merge'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('ignores non-matching scopes', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import { x } from '@other/pkg/src/deep'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('respects custom scopes config', () => {
    const customRule = createImportRestrictionRule({ scopes: ['@myorg'] })
    const result = customRule.check(ctx([
      { path: 'src/service.ts', content: "import { x } from '@myorg/lib/src/deep'" },
    ]))
    expect(result.passed).toBe(false)
  })

  it('handles empty file list', () => {
    const result = rule.check(ctx([]))
    expect(result.passed).toBe(true)
  })

  it('handles file with no imports', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: 'const x = 1' },
    ]))
    expect(result.passed).toBe(true)
  })

  it('handles type imports', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: "import type { x } from '@dzupagent/core/src/internal'" },
    ]))
    expect(result.passed).toBe(false)
  })
})

// ===========================================================================
// NamingConventionRule
// ===========================================================================

describe('NamingConventionRule', () => {
  const rule = createNamingConventionRule()

  it('has correct id and category', () => {
    expect(rule.id).toBe('naming-convention')
    expect(rule.category).toBe('naming')
    expect(rule.severity).toBe('warning')
  })

  // --- file naming ---
  it('passes for kebab-case filenames', () => {
    const result = rule.check(ctx([
      { path: 'src/my-service.ts', content: '' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })

  it('flags PascalCase filenames under kebab-case convention', () => {
    const result = rule.check(ctx([
      { path: 'src/MyService.ts', content: '' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(1)
    expect(fileViolations[0]!.message).toContain('kebab-case')
  })

  it('flags camelCase filenames under kebab-case convention', () => {
    const result = rule.check(ctx([
      { path: 'src/myService.ts', content: '' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(1)
  })

  it('skips index files for filename check', () => {
    const result = rule.check(ctx([
      { path: 'src/index.ts', content: '' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })

  it('skips dotfiles for filename check', () => {
    const result = rule.check(ctx([
      { path: 'src/.env.ts', content: '' },
    ]))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })

  // --- export naming: classes ---
  it('passes for PascalCase class exports', () => {
    const result = rule.check(ctx([
      { path: 'src/good.ts', content: 'export class MyService {}' },
    ]))
    const classViolations = result.violations.filter((v) => v.message.includes('class'))
    expect(classViolations).toHaveLength(0)
  })

  it('flags lowercase class exports', () => {
    const result = rule.check(ctx([
      { path: 'src/good.ts', content: 'export class myService {}' },
    ]))
    expect(result.violations.some((v) => v.message.includes('PascalCase'))).toBe(true)
  })

  // --- export naming: interfaces ---
  it('passes for PascalCase interface exports', () => {
    const result = rule.check(ctx([
      { path: 'src/types.ts', content: 'export interface MyConfig {}' },
    ]))
    const ifaceViolations = result.violations.filter((v) => v.message.includes('interface'))
    expect(ifaceViolations).toHaveLength(0)
  })

  it('flags lowercase interface exports', () => {
    const result = rule.check(ctx([
      { path: 'src/types.ts', content: 'export interface myConfig {}' },
    ]))
    expect(result.violations.some((v) => v.message.includes('PascalCase'))).toBe(true)
  })

  // --- export naming: functions ---
  it('passes for camelCase function exports', () => {
    const result = rule.check(ctx([
      { path: 'src/utils.ts', content: 'export function doSomething() {}' },
    ]))
    const funcViolations = result.violations.filter((v) => v.message.includes('function'))
    expect(funcViolations).toHaveLength(0)
  })

  it('flags PascalCase function exports under camelCase convention', () => {
    const result = rule.check(ctx([
      { path: 'src/utils.ts', content: 'export function DoSomething() {}' },
    ]))
    const funcViolations = result.violations.filter((v) => v.message.includes('function'))
    expect(funcViolations).toHaveLength(1)
  })

  // --- export naming: types ---
  it('passes for PascalCase type exports', () => {
    const result = rule.check(ctx([
      { path: 'src/types.ts', content: 'export type MyType = string' },
    ]))
    const typeViolations = result.violations.filter((v) => v.message.includes('type'))
    expect(typeViolations).toHaveLength(0)
  })

  it('flags lowercase type exports', () => {
    const result = rule.check(ctx([
      { path: 'src/types.ts', content: 'export type myType = string' },
    ]))
    expect(result.violations.some((v) => v.message.includes('PascalCase'))).toBe(true)
  })

  // --- export naming: enums ---
  it('passes for PascalCase enum exports', () => {
    const result = rule.check(ctx([
      { path: 'src/enums.ts', content: 'export enum Color { Red, Green }' },
    ]))
    const enumViolations = result.violations.filter((v) => v.message.includes('enum'))
    expect(enumViolations).toHaveLength(0)
  })

  it('flags lowercase enum exports', () => {
    const result = rule.check(ctx([
      { path: 'src/enums.ts', content: 'export enum color { Red, Green }' },
    ]))
    expect(result.violations.some((v) => v.message.includes('PascalCase'))).toBe(true)
  })

  // --- edge cases ---
  it('handles empty files', () => {
    const result = rule.check(ctx([{ path: 'src/ok.ts', content: '' }]))
    expect(result.violations.filter((v) => v.message.includes('export'))).toHaveLength(0)
  })

  it('handles empty file list', () => {
    const result = rule.check(ctx([]))
    expect(result.violations).toHaveLength(0)
  })

  it('checks PascalCase convention for file naming', () => {
    const result = rule.check(ctx(
      [{ path: 'src/MyService.ts', content: '' }],
      { conventions: makeConventions({ fileNaming: 'PascalCase' }) },
    ))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })

  it('checks snake_case convention for file naming', () => {
    const result = rule.check(ctx(
      [{ path: 'src/my_service.ts', content: '' }],
      { conventions: makeConventions({ fileNaming: 'snake_case' }) },
    ))
    const fileViolations = result.violations.filter((v) => v.message.includes('File name'))
    expect(fileViolations).toHaveLength(0)
  })
})

// ===========================================================================
// TypeSafetyRule
// ===========================================================================

describe('TypeSafetyRule', () => {
  const rule = createTypeSafetyRule()

  it('has correct id and category', () => {
    expect(rule.id).toBe('type-safety')
    expect(rule.category).toBe('patterns')
  })

  // --- happy path ---
  it('passes clean TypeScript code', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: 'export function greet(name: string): string { return name }' },
    ]))
    expect(result.passed).toBe(true)
  })

  // --- violations ---
  it('detects generic <any> usage', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: 'const arr: Array<any> = []' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('Generic')
  })

  it('detects @ts-nocheck', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: '// @ts-nocheck\nconst x = 1' },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.message.includes('@ts-nocheck'))).toBe(true)
  })

  it('treats @ts-expect-error as warning (passed = true)', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: '// @ts-expect-error testing\nconst x = 1' },
    ]))
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.severity).toBe('warning')
  })

  // --- edge cases ---
  it('skips non-TypeScript files', () => {
    const result = rule.check(ctx([
      { path: 'src/readme.md', content: 'Use any type' },
    ]))
    expect(result.violations).toHaveLength(0)
  })

  it('handles empty file', () => {
    const result = rule.check(ctx([{ path: 'src/empty.ts', content: '' }]))
    expect(result.passed).toBe(true)
  })

  it('handles .mts files', () => {
    const result = rule.check(ctx([
      { path: 'src/module.mts', content: 'const x: any = 1' },
    ]))
    expect(result.passed).toBe(false)
  })

  it('handles .cts files', () => {
    const result = rule.check(ctx([
      { path: 'src/module.cts', content: 'const x: any = 1' },
    ]))
    expect(result.passed).toBe(false)
  })

  it('does not flag "any" in comments for code lines check', () => {
    const result = rule.check(ctx([
      { path: 'src/service.ts', content: '// This function accepts any value\nconst x: string = "ok"' },
    ]))
    // The comment line should not trigger any violation for "any" type
    expect(result.violations).toHaveLength(0)
  })
})

// ===========================================================================
// LayeringRule
// ===========================================================================

describe('LayeringRule', () => {
  const rule = createLayeringRule()

  it('has correct id and category', () => {
    expect(rule.id).toBe('layering')
    expect(rule.category).toBe('layering')
  })

  // --- happy path ---
  it('allows higher-layer importing lower-layer', () => {
    const result = rule.check(ctx([
      { path: 'packages/agent/src/service.ts', content: "import { x } from '@dzupagent/core'" },
    ]))
    expect(result.passed).toBe(true)
  })

  // --- violations ---
  it('forbids core importing from server', () => {
    const result = rule.check(ctx([
      { path: 'packages/core/src/bad.ts', content: "import { Handler } from '@dzupagent/server'" },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations[0]!.message).toContain('layer')
  })

  it('supports custom layers', () => {
    const customRule = createLayeringRule([['@custom/base'], ['@custom/app']])
    const structure: ProjectStructure = {
      packages: new Map([
        ['@custom/base', { name: '@custom/base', dir: 'packages/base/', allowedDependencies: [], entryPoints: ['index.ts'] }],
        ['@custom/app', { name: '@custom/app', dir: 'packages/app/', allowedDependencies: ['@custom/base'], entryPoints: ['index.ts'] }],
      ]),
      rootDir: '.',
    }
    const result = customRule.check(ctx(
      [{ path: 'packages/base/src/bad.ts', content: "import { x } from '@custom/app'" }],
      { projectStructure: structure },
    ))
    expect(result.passed).toBe(false)
  })

  // --- edge cases ---
  it('ignores files not in any known package', () => {
    const result = rule.check(ctx([
      { path: 'scripts/build.ts', content: "import { x } from '@dzupagent/server'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('ignores packages not in any layer', () => {
    const result = rule.check(ctx([
      { path: 'packages/core/src/util.ts', content: "import { x } from '@unknown/pkg'" },
    ]))
    expect(result.passed).toBe(true)
  })

  it('handles empty files', () => {
    const result = rule.check(ctx([{ path: 'packages/core/src/empty.ts', content: '' }]))
    expect(result.passed).toBe(true)
  })
})

// ===========================================================================
// ContractComplianceRule
// ===========================================================================

describe('ContractComplianceRule', () => {
  const rule = createContractComplianceRule()

  it('has correct id and category', () => {
    expect(rule.id).toBe('contract-compliance')
    expect(rule.category).toBe('contracts')
  })

  // --- happy path ---
  it('passes when class implements all members', () => {
    const result = rule.check(ctx([
      {
        path: 'src/types.ts',
        content: 'export interface Greeter {\n  greet(name: string): string\n}',
      },
      {
        path: 'src/impl.ts',
        content: 'export class EnglishGreeter implements Greeter {\n  greet(name: string): string {\n    return name\n  }\n}',
      },
    ]))
    expect(result.passed).toBe(true)
  })

  // --- violations ---
  it('detects missing property', () => {
    const result = rule.check(ctx([
      {
        path: 'src/types.ts',
        content: 'export interface Config {\n  name: string\n  timeout: number\n}',
      },
      {
        path: 'src/impl.ts',
        content: 'export class AppConfig implements Config {\n  name = "app"\n}',
      },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.message.includes('timeout'))).toBe(true)
  })

  it('detects multiple missing members', () => {
    const result = rule.check(ctx([
      {
        path: 'src/types.ts',
        content: 'export interface Handler {\n  handle(): void\n  cleanup(): void\n  readonly name: string\n}',
      },
      {
        path: 'src/impl.ts',
        content: 'export class MyHandler implements Handler {\n  handle(): void {}\n}',
      },
    ]))
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(2)
  })

  // --- edge cases ---
  it('skips when interface is not in generated files', () => {
    const result = rule.check(ctx([
      {
        path: 'src/impl.ts',
        content: 'export class MyClass implements ExternalInterface {\n  doWork(): void {}\n}',
      },
    ]))
    expect(result.passed).toBe(true)
  })

  it('handles class with no implements clause', () => {
    const result = rule.check(ctx([
      {
        path: 'src/impl.ts',
        content: 'export class SimpleClass {\n  doWork(): void {}\n}',
      },
    ]))
    expect(result.passed).toBe(true)
  })

  it('handles empty file list', () => {
    const result = rule.check(ctx([]))
    expect(result.passed).toBe(true)
  })

  it('handles class implementing multiple interfaces', () => {
    const result = rule.check(ctx([
      {
        path: 'src/types.ts',
        content: 'export interface Readable {\n  read(): string\n}\nexport interface Writable {\n  write(data: string): void\n}',
      },
      {
        path: 'src/impl.ts',
        content: 'export class FileStream implements Readable, Writable {\n  read(): string {\n    return ""\n  }\n  write(data: string): void {}\n}',
      },
    ]))
    expect(result.passed).toBe(true)
  })
})
