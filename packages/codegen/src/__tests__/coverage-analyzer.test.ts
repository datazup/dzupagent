import { describe, it, expect } from 'vitest'
import { analyzeCoverage, findUncoveredFiles } from '../quality/coverage-analyzer.js'

// ---------------------------------------------------------------------------
// analyzeCoverage
// ---------------------------------------------------------------------------

describe('analyzeCoverage', () => {
  // NOTE: The default sourcePattern is 'src/**/*.ts' which requires a subdirectory
  // (the glob ** translates to a regex that requires at least one path segment after src/).

  it('identifies covered files when test files exist', () => {
    const files: Record<string, string> = {
      'src/lib/foo.ts': 'export function foo() {}',
      'src/__tests__/foo.test.ts': 'test("foo", () => {})',
    }
    const report = analyzeCoverage(files)
    expect(report.coveredFiles).toContain('src/lib/foo.ts')
    expect(report.uncoveredFiles).toHaveLength(0)
    expect(report.ratio).toBe(1)
  })

  it('identifies uncovered files', () => {
    const files: Record<string, string> = {
      'src/lib/bar.ts': 'export function bar() {}',
    }
    const report = analyzeCoverage(files)
    expect(report.uncoveredFiles).toContain('src/lib/bar.ts')
    expect(report.coveredFiles).toHaveLength(0)
    expect(report.ratio).toBe(0)
  })

  it('excludes index.ts and types.ts by default', () => {
    const files: Record<string, string> = {
      'src/lib/index.ts': 'export {}',
      'src/lib/types.ts': 'export interface X {}',
      'src/lib/foo-types.ts': 'export type Y = string',
    }
    const report = analyzeCoverage(files)
    expect(report.coveredFiles).toHaveLength(0)
    expect(report.uncoveredFiles).toHaveLength(0)
  })

  it('does not count test files as source files', () => {
    const files: Record<string, string> = {
      'src/lib/foo.test.ts': 'test("x", () => {})',
      'src/lib/foo.spec.ts': 'describe("x", () => {})',
    }
    const report = analyzeCoverage(files)
    expect(report.coveredFiles).toHaveLength(0)
    expect(report.uncoveredFiles).toHaveLength(0)
    expect(report.ratio).toBe(0)
  })

  it('matches .spec.ts test files', () => {
    const files: Record<string, string> = {
      'src/lib/utils.ts': 'export function util() {}',
      'src/lib/utils.spec.ts': 'it("works", () => {})',
    }
    const report = analyzeCoverage(files)
    expect(report.coveredFiles).toContain('src/lib/utils.ts')
  })

  it('handles empty input', () => {
    const report = analyzeCoverage({})
    expect(report.ratio).toBe(0)
    expect(report.coveredFiles).toHaveLength(0)
    expect(report.uncoveredFiles).toHaveLength(0)
  })

  it('computes partial coverage ratio', () => {
    const files: Record<string, string> = {
      'src/lib/a.ts': 'code',
      'src/lib/b.ts': 'code',
      'src/__tests__/a.test.ts': 'test',
    }
    const report = analyzeCoverage(files)
    expect(report.ratio).toBe(0.5)
    expect(report.coveredFiles).toHaveLength(1)
    expect(report.uncoveredFiles).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// findUncoveredFiles
// ---------------------------------------------------------------------------

describe('findUncoveredFiles', () => {
  it('returns uncovered files sorted by priority', () => {
    const files: Record<string, string> = {
      'src/lib/big.ts': 'export function a() {}\nexport function b() {}\n' + 'line\n'.repeat(100),
      'src/lib/small.ts': 'export function x() {}',
    }
    const result = findUncoveredFiles(files)
    expect(result).toHaveLength(2)
    // big.ts should come first (higher priority)
    expect(result[0]!.filePath).toBe('src/lib/big.ts')
    expect(result[0]!.priority).toBeGreaterThan(result[1]!.priority)
  })

  it('includes reason with export count and line count', () => {
    const files: Record<string, string> = {
      'src/lib/mod.ts': 'export function foo() {}\nexport const bar = 1',
    }
    const result = findUncoveredFiles(files)
    expect(result[0]!.reason).toContain('2 export(s)')
  })

  it('handles files with no exports', () => {
    const files: Record<string, string> = {
      'src/lib/internal.ts': 'function helper() {}\nconst x = 1',
    }
    const result = findUncoveredFiles(files)
    expect(result[0]!.reason).toContain('no detected exports')
  })

  it('returns empty when all files are covered', () => {
    const files: Record<string, string> = {
      'src/lib/foo.ts': 'export const x = 1',
      'src/lib/foo.test.ts': 'test("x", () => {})',
    }
    expect(findUncoveredFiles(files)).toHaveLength(0)
  })
})
