import { describe, it, expect } from 'vitest'
import { detectConventions, type ConventionReport, type DetectedConvention } from '../conventions/convention-detector.js'
import { FrameworkAdapter } from '../adaptation/framework-adapter.js'
import { GuardrailReporter } from '../guardrails/guardrail-reporter.js'
import type { GuardrailReport, GuardrailViolation } from '../guardrails/guardrail-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findConvention(report: ConventionReport, name: string): DetectedConvention | undefined {
  return report.conventions.find(c => c.name === name)
}

function makeViolation(overrides: Partial<GuardrailViolation> = {}): GuardrailViolation {
  return {
    ruleId: 'naming-convention',
    file: 'src/foo.ts',
    message: 'Bad name',
    severity: 'warning',
    autoFixable: false,
    ...overrides,
  }
}

function makeReport(violations: GuardrailViolation[], passed = false): GuardrailReport {
  const errors = violations.filter(v => v.severity === 'error').length
  const warnings = violations.filter(v => v.severity === 'warning').length
  const infos = violations.filter(v => v.severity === 'info').length
  return {
    passed,
    totalViolations: violations.length,
    errorCount: errors,
    warningCount: warnings,
    infoCount: infos,
    ruleResults: new Map(),
    violations,
  }
}

// ============================================================================
// detectConventions
// ============================================================================
describe('detectConventions', () => {
  // ---- Naming ----
  describe('naming detection', () => {
    it('detects camelCase variables when dominant', () => {
      const files = {
        'a.ts': [
          'const fooBar = 1',
          'let bazQux = 2',
          'function doStuff() {}',
          'const helloWorld = true',
        ].join('\n'),
      }
      const report = detectConventions(files)
      const naming = findConvention(report, 'camelCase variables')
      expect(naming).toBeDefined()
      expect(naming!.category).toBe('naming')
      expect(naming!.confidence).toBeGreaterThan(0)
    })

    it('detects snake_case variables when dominant', () => {
      const files = {
        'a.py': [
          'const foo_bar = 1',
          'let baz_qux = 2',
          'function do_stuff() {}',
          'const hello_world = true',
        ].join('\n'),
      }
      const report = detectConventions(files)
      const naming = findConvention(report, 'snake_case variables')
      expect(naming).toBeDefined()
    })

    it('detects PascalCase types', () => {
      const files = {
        'a.ts': [
          'class UserService {}',
          'interface AuthConfig {}',
          'type HttpResponse = string',
        ].join('\n'),
      }
      const report = detectConventions(files)
      const pascal = findConvention(report, 'PascalCase types')
      expect(pascal).toBeDefined()
      expect(pascal!.examples).toContain('UserService')
      expect(pascal!.confidence).toBe(0.95)
    })

    it('limits PascalCase examples to 3', () => {
      const files = {
        'a.ts': [
          'class A {}', 'class B {}', 'class C {}', 'class D {}', 'class E {}',
        ].join('\n'),
      }
      const report = detectConventions(files)
      const pascal = findConvention(report, 'PascalCase types')
      expect(pascal!.examples.length).toBe(3)
    })

    it('returns empty naming when no variables found', () => {
      const files = { 'a.ts': '// comment only' }
      const report = detectConventions(files)
      expect(report.conventions.filter(c => c.category === 'naming').length).toBe(0)
    })
  })

  // ---- Formatting ----
  describe('formatting detection', () => {
    it('detects 2-space indentation', () => {
      const lines = Array.from({ length: 20 }, () => '  something').join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const indent = report.conventions.find(c => c.name.startsWith('indent-'))
      expect(indent).toBeDefined()
      expect(indent!.name).toBe('indent-2spaces')
    })

    it('detects 4-space indentation', () => {
      const lines = Array.from({ length: 20 }, () => '    something').join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const indent = report.conventions.find(c => c.name.startsWith('indent-'))
      expect(indent!.name).toBe('indent-4spaces')
    })

    it('detects tab indentation', () => {
      const lines = Array.from({ length: 20 }, () => '\tsomething').join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const indent = report.conventions.find(c => c.name.startsWith('indent-'))
      expect(indent!.name).toBe('indent-tabs')
    })

    it('detects single quotes', () => {
      const lines = [
        "const a = 'hello'",
        "const b = 'world'",
        "const c = 'test'",
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const quotes = findConvention(report, 'single-quotes')
      expect(quotes).toBeDefined()
    })

    it('detects double quotes', () => {
      const lines = [
        'const a = "hello"',
        'const b = "world"',
        'const c = "test"',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const quotes = findConvention(report, 'double-quotes')
      expect(quotes).toBeDefined()
    })

    it('detects semicolons', () => {
      const lines = [
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const semi = findConvention(report, 'semicolons')
      expect(semi).toBeDefined()
    })

    it('detects no-semicolons', () => {
      const lines = [
        'const a = 1',
        'const b = 2',
        'const c = 3',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const semi = findConvention(report, 'no-semicolons')
      expect(semi).toBeDefined()
    })
  })

  // ---- Imports ----
  describe('import detection', () => {
    it('detects relative imports', () => {
      const lines = [
        "import { a } from './a.js'",
        "import { b } from '../b.js'",
        "import { c } from './c.js'",
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const imp = findConvention(report, 'relative-imports')
      expect(imp).toBeDefined()
    })

    it('detects alias imports', () => {
      const lines = [
        "import { a } from '@/a'",
        "import { b } from '@libs/b'",
        "import { c } from '~/c'",
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const imp = findConvention(report, 'alias-imports')
      expect(imp).toBeDefined()
    })

    it('detects type imports', () => {
      const lines = [
        "import type { Foo } from './foo.js'",
        "import { bar } from './bar.js'",
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const ti = findConvention(report, 'type-imports')
      expect(ti).toBeDefined()
    })
  })

  // ---- Patterns ----
  describe('pattern detection', () => {
    it('detects async/await preference', () => {
      const lines = [
        'await fetchData()',
        'await processResult()',
        'await saveData()',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const p = findConvention(report, 'async-await')
      expect(p).toBeDefined()
    })

    it('detects .then() preference', () => {
      const lines = [
        'fetchData().then(r => r)',
        'processResult().then(r => r)',
        'saveData().then(r => r)',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const p = findConvention(report, 'promise-then')
      expect(p).toBeDefined()
    })

    it('detects function-style preference', () => {
      const lines = [
        'export function doA() {}',
        'export function doB() {}',
        'export async function doC() {}',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const p = findConvention(report, 'function-style')
      expect(p).toBeDefined()
    })

    it('detects class-style preference', () => {
      const lines = [
        'export class ServiceA {}',
        'export class ServiceB {}',
        'export class ServiceC {}',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const p = findConvention(report, 'class-style')
      expect(p).toBeDefined()
    })

    it('detects named-exports preference', () => {
      const lines = [
        'export const a = 1',
        'export function b() {}',
        'export class C {}',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const p = findConvention(report, 'named-exports')
      expect(p).toBeDefined()
    })

    it('detects default-exports preference', () => {
      const lines = [
        'export default class A {}',
        'export default function() {}',
        'export default {}',
      ].join('\n')
      const report = detectConventions({ 'a.ts': lines })
      const p = findConvention(report, 'default-exports')
      expect(p).toBeDefined()
    })
  })

  // ---- Structure ----
  describe('structure detection', () => {
    it('detects barrel exports', () => {
      const files: Record<string, string> = {
        'src/index.ts': 'export * from "./a"',
        'src/a.ts': 'export const a = 1',
        'src/b.ts': 'export const b = 2',
        'src/utils/index.ts': 'export * from "./c"',
      }
      const report = detectConventions(files)
      const barrel = findConvention(report, 'barrel-exports')
      expect(barrel).toBeDefined()
      expect(barrel!.examples.length).toBeGreaterThan(0)
    })

    it('detects flat structure', () => {
      const files: Record<string, string> = {
        'src/a.ts': '',
        'src/b.ts': '',
        'src/c.ts': '',
        'src/d.ts': '',
      }
      const report = detectConventions(files)
      const s = findConvention(report, 'flat-structure')
      expect(s).toBeDefined()
    })

    it('detects nested structure', () => {
      const files: Record<string, string> = {
        'src/features/auth/service/handler.ts': '',
        'src/features/auth/service/validator.ts': '',
        'src/features/user/service/handler.ts': '',
        'src/features/user/service/validator.ts': '',
      }
      const report = detectConventions(files)
      const s = findConvention(report, 'nested-structure')
      expect(s).toBeDefined()
    })
  })

  // ---- Language ----
  describe('language detection', () => {
    it('detects TypeScript', () => {
      const report = detectConventions({ 'a.ts': '', 'b.tsx': '' })
      expect(report.language).toBe('typescript')
    })

    it('detects JavaScript', () => {
      const report = detectConventions({ 'a.js': '', 'b.jsx': '', 'c.js': '' })
      expect(report.language).toBe('javascript')
    })
  })

  // ---- Report shape ----
  it('returns correct report shape', () => {
    const report = detectConventions({ 'a.ts': 'const x = 1' })
    expect(report).toHaveProperty('conventions')
    expect(report).toHaveProperty('language')
    expect(report).toHaveProperty('filesAnalyzed')
    expect(report.filesAnalyzed).toBe(1)
  })

  it('filters conventions below 0.1 confidence', () => {
    // edge case: ratio(0,0) = 0.5 => confidence = 0 should be filtered
    const report = detectConventions({ 'a.ts': '' })
    for (const c of report.conventions) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.1)
    }
  })
})

// ============================================================================
// FrameworkAdapter
// ============================================================================
describe('FrameworkAdapter', () => {
  it('creates with builtin mappings', () => {
    const adapter = new FrameworkAdapter()
    expect(adapter).toBeDefined()
  })

  describe('mapPath — builtin express->nextjs', () => {
    it('maps route files', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('routes/users.routes.ts', 'express', 'nextjs')
      expect(result).toBe('app/api/users/route.ts')
    })

    it('maps controller files', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('controllers/auth.controller.ts', 'express', 'nextjs')
      expect(result).toBe('app/api/auth/route.ts')
    })

    it('maps service files', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('services/user.service.ts', 'express', 'nextjs')
      expect(result).toBe('lib/services/user.service.ts')
    })

    it('maps middleware files', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('middleware/cors.ts', 'express', 'nextjs')
      expect(result).toBe('lib/middleware/cors.ts')
    })

    it('returns null for unmatchable paths', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('random/file.ts', 'express', 'nextjs')
      expect(result).toBeNull()
    })
  })

  describe('mapPath — builtin express->sveltekit', () => {
    it('maps route files', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('routes/users.routes.ts', 'express', 'sveltekit')
      expect(result).toContain('+server.ts')
    })
  })

  describe('mapPath — builtin express->fastify', () => {
    it('maps middleware to plugins', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('middleware/auth.ts', 'express', 'fastify')
      expect(result).toContain('plugin')
    })
  })

  describe('mapPath — builtin nextjs->express', () => {
    it('maps app/api routes to src/routes', () => {
      const adapter = new FrameworkAdapter()
      const result = adapter.mapPath('app/api/users/route.ts', 'nextjs', 'express')
      expect(result).toContain('routes')
    })
  })

  it('returns null for unknown framework pairs', () => {
    const adapter = new FrameworkAdapter()
    expect(adapter.mapPath('file.ts', 'unknown', 'unknown')).toBeNull()
  })

  describe('frontend adaptation guides', () => {
    it('has vue3->react guide', () => {
      const adapter = new FrameworkAdapter()
      const guide = adapter.getAdaptationGuide('vue3', 'react')
      expect(guide).toContain('useState')
    })

    it('has react->vue3 guide', () => {
      const adapter = new FrameworkAdapter()
      const guide = adapter.getAdaptationGuide('react', 'vue3')
      expect(guide).toContain('ref()')
    })

    it('has vue3->svelte guide', () => {
      const adapter = new FrameworkAdapter()
      const guide = adapter.getAdaptationGuide('vue3', 'svelte')
      expect(guide).toContain('$state')
    })

    it('has react->svelte guide', () => {
      const adapter = new FrameworkAdapter()
      const guide = adapter.getAdaptationGuide('react', 'svelte')
      expect(guide).toContain('$effect')
    })

    it('returns null for unknown pair', () => {
      const adapter = new FrameworkAdapter()
      expect(adapter.getAdaptationGuide('angular', 'react')).toBeNull()
    })
  })

  describe('custom mappings and guides', () => {
    it('allows adding custom backend mapping', async () => {
      const adapter = new FrameworkAdapter()
      const { PathMapper } = await import('../adaptation/path-mapper.js')
      const mapper = new PathMapper()
      mapper.addMapping('src/(.*)\\.ts', 'lib/$1.ts')
      adapter.addBackendMapping('custom', 'custom2', mapper)
      expect(adapter.mapPath('src/foo.ts', 'custom', 'custom2')).toBe('lib/foo.ts')
    })

    it('allows adding custom frontend guide', () => {
      const adapter = new FrameworkAdapter()
      adapter.addFrontendGuide('angular', 'react', 'Use hooks instead of services')
      expect(adapter.getAdaptationGuide('angular', 'react')).toBe('Use hooks instead of services')
    })
  })
})

// ============================================================================
// GuardrailReporter
// ============================================================================
describe('GuardrailReporter', () => {
  describe('text format', () => {
    it('renders PASSED header when report passes', () => {
      const reporter = new GuardrailReporter({ format: 'text' })
      const report = makeReport([], true)
      const text = reporter.format(report)
      expect(text).toContain('PASSED')
    })

    it('renders FAILED header when report fails', () => {
      const reporter = new GuardrailReporter({ format: 'text' })
      const report = makeReport([makeViolation()])
      const text = reporter.format(report)
      expect(text).toContain('FAILED')
    })

    it('shows violation counts in summary', () => {
      const reporter = new GuardrailReporter({ format: 'text' })
      const report = makeReport([
        makeViolation({ severity: 'error' }),
        makeViolation({ severity: 'warning' }),
        makeViolation({ severity: 'info' }),
      ])
      const text = reporter.format(report)
      expect(text).toContain('Errors: 1')
      expect(text).toContain('Warnings: 1')
      expect(text).toContain('Info: 1')
    })

    it('includes file and message in output', () => {
      const reporter = new GuardrailReporter({ format: 'text' })
      const report = makeReport([makeViolation({ file: 'src/bar.ts', message: 'invalid naming' })])
      const text = reporter.format(report)
      expect(text).toContain('src/bar.ts')
      expect(text).toContain('invalid naming')
    })

    it('shows line number when present', () => {
      const reporter = new GuardrailReporter({ format: 'text' })
      const report = makeReport([makeViolation({ file: 'src/a.ts', line: 42 })])
      const text = reporter.format(report)
      expect(text).toContain('src/a.ts:42')
    })

    it('shows suggestions when enabled', () => {
      const reporter = new GuardrailReporter({ format: 'text', showSuggestions: true })
      const report = makeReport([makeViolation({ suggestion: 'Rename to camelCase' })])
      const text = reporter.format(report)
      expect(text).toContain('Fix: Rename to camelCase')
    })

    it('hides suggestions when disabled', () => {
      const reporter = new GuardrailReporter({ format: 'text', showSuggestions: false })
      const report = makeReport([makeViolation({ suggestion: 'Rename to camelCase' })])
      const text = reporter.format(report)
      expect(text).not.toContain('Fix: Rename to camelCase')
    })

    it('hides info when showInfo is false', () => {
      const reporter = new GuardrailReporter({ format: 'text', showInfo: false })
      const report = makeReport([
        makeViolation({ severity: 'info', message: 'info-only' }),
        makeViolation({ severity: 'error', message: 'real-error' }),
      ])
      const text = reporter.format(report)
      expect(text).not.toContain('info-only')
      expect(text).toContain('real-error')
    })

    it('groups by category when enabled', () => {
      const reporter = new GuardrailReporter({ format: 'text', groupByCategory: true })
      const report = makeReport([
        makeViolation({ ruleId: 'naming-convention', message: 'name-issue' }),
        makeViolation({ ruleId: 'layering', message: 'layer-issue' }),
      ])
      const text = reporter.format(report)
      expect(text).toContain('NAMING')
      expect(text).toContain('LAYERING')
    })

    it('renders flat list when groupByCategory is false', () => {
      const reporter = new GuardrailReporter({ format: 'text', groupByCategory: false })
      const report = makeReport([
        makeViolation({ severity: 'error', message: 'err1' }),
        makeViolation({ severity: 'warning', message: 'warn1' }),
      ])
      const text = reporter.format(report)
      expect(text).toContain('err1')
      expect(text).toContain('warn1')
      expect(text).not.toContain('---')
    })

    it('shows no violations message for empty report', () => {
      const reporter = new GuardrailReporter({ format: 'text' })
      const report = makeReport([], true)
      const text = reporter.format(report)
      expect(text).toContain('No violations found')
    })
  })

  describe('JSON format', () => {
    it('produces valid JSON', () => {
      const reporter = new GuardrailReporter({ format: 'json' })
      const report = makeReport([makeViolation()])
      const json = reporter.format(report)
      expect(() => JSON.parse(json)).not.toThrow()
    })

    it('includes passed status', () => {
      const reporter = new GuardrailReporter({ format: 'json' })
      const report = makeReport([], true)
      const parsed = JSON.parse(reporter.format(report)) as Record<string, unknown>
      expect(parsed['passed']).toBe(true)
    })

    it('includes summary counts', () => {
      const reporter = new GuardrailReporter({ format: 'json' })
      const report = makeReport([
        makeViolation({ severity: 'error' }),
        makeViolation({ severity: 'warning' }),
      ])
      const parsed = JSON.parse(reporter.format(report)) as Record<string, Record<string, number>>
      expect(parsed['summary']!['errors']).toBe(1)
      expect(parsed['summary']!['warnings']).toBe(1)
    })

    it('includes violation details', () => {
      const reporter = new GuardrailReporter({ format: 'json' })
      const report = makeReport([makeViolation({ file: 'src/x.ts', message: 'bad', line: 10 })])
      const parsed = JSON.parse(reporter.format(report)) as { violations: Array<Record<string, unknown>> }
      expect(parsed.violations.length).toBe(1)
      expect(parsed.violations[0]!['file']).toBe('src/x.ts')
      expect(parsed.violations[0]!['line']).toBe(10)
    })

    it('filters info when showInfo is false', () => {
      const reporter = new GuardrailReporter({ format: 'json', showInfo: false })
      const report = makeReport([
        makeViolation({ severity: 'info' }),
        makeViolation({ severity: 'error' }),
      ])
      const parsed = JSON.parse(reporter.format(report)) as { violations: Array<Record<string, unknown>> }
      expect(parsed.violations.length).toBe(1)
    })
  })

  describe('category mapping', () => {
    it('maps known ruleIds to categories', () => {
      const reporter = new GuardrailReporter({ format: 'text', groupByCategory: true })
      const ruleIds = ['layering', 'import-restriction', 'naming-convention', 'security', 'type-safety', 'contract-compliance']
      for (const ruleId of ruleIds) {
        const report = makeReport([makeViolation({ ruleId })])
        const text = reporter.format(report)
        // should not throw and should have some category header
        expect(text).toContain('---')
      }
    })

    it('defaults unknown ruleIds to patterns category', () => {
      const reporter = new GuardrailReporter({ format: 'text', groupByCategory: true })
      const report = makeReport([makeViolation({ ruleId: 'unknown-rule' })])
      const text = reporter.format(report)
      expect(text).toContain('PATTERNS')
    })
  })

  describe('defaults', () => {
    it('defaults to text format', () => {
      const reporter = new GuardrailReporter()
      const report = makeReport([], true)
      const text = reporter.format(report)
      expect(text).toContain('PASSED')
    })
  })
})
