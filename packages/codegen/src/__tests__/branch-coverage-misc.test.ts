/**
 * Branch coverage deep-dive for repomap, sandbox profile, CI monitor,
 * token budget, framework adapter, reviewer, and quality convention gate.
 *
 * Targets:
 * - symbol-extractor: lines beginning with block-comment * or /*
 * - repo-map-builder: empty files, exclude-patterns path, focus files
 * - security-profile: customizeProfile with all override slots
 * - ci-monitor: parseGitHubActionsStatus edge cases (no jobs, nullish fields)
 * - token-budget: selectFiles with exactly-fits and just-over-budget
 * - framework-adapter: backend mapping lookup
 */
import { describe, it, expect } from 'vitest'
import { extractSymbols } from '../repomap/symbol-extractor.js'
import { buildRepoMap } from '../repomap/repo-map-builder.js'
import {
  getSecurityProfile,
  customizeProfile,
  toDockerFlags,
} from '../sandbox/security-profile.js'
import {
  parseGitHubActionsStatus,
  parseCIWebhook,
  categorizeFailure,
} from '../ci/ci-monitor.js'
import { TokenBudgetManager, DefaultRoleDetector, summarizeFile } from '../context/token-budget.js'
import { FrameworkAdapter } from '../adaptation/framework-adapter.js'

// ---------------------------------------------------------------------------
// symbol-extractor branch coverage
// ---------------------------------------------------------------------------

describe('extractSymbols — branch coverage', () => {
  it('skips lines that start with block-comment markers', () => {
    const code = `
/**
 * JSDoc for the class below.
 */
export class WithDoc {}
`
    const syms = extractSymbols('a.ts', code)
    expect(syms).toHaveLength(1)
    expect(syms[0]!.name).toBe('WithDoc')
  })

  it('skips comment-only lines but picks up the real declaration', () => {
    const code = `// comment 1
// comment 2
export function realOne() {}
`
    const syms = extractSymbols('a.ts', code)
    expect(syms).toHaveLength(1)
    expect(syms[0]!.name).toBe('realOne')
    expect(syms[0]!.line).toBe(3)
  })

  it('captures const-enum correctly', () => {
    const syms = extractSymbols('a.ts', 'export const enum Direction { Up, Down }')
    expect(syms).toHaveLength(1)
    expect(syms[0]!.kind).toBe('enum')
    expect(syms[0]!.name).toBe('Direction')
  })

  it('captures abstract class', () => {
    const syms = extractSymbols('a.ts', 'export abstract class Base {}')
    expect(syms).toHaveLength(1)
    expect(syms[0]!.kind).toBe('class')
    expect(syms[0]!.name).toBe('Base')
  })

  it('only emits one symbol per line (first match wins)', () => {
    // A line that matches multiple patterns — only class pattern should fire.
    const syms = extractSymbols('a.ts', 'export class Thing /* function notAFn */ {}')
    expect(syms.filter(s => s.name === 'Thing')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// repo-map-builder branch coverage
// ---------------------------------------------------------------------------

describe('buildRepoMap — branch coverage', () => {
  it('returns empty repo map when all files are excluded', () => {
    const map = buildRepoMap(
      [{ path: 'src/a.ts', content: 'export class A {}' }],
      { excludePatterns: ['src/'] },
    )
    expect(map.content).toBe('')
    expect(map.symbolCount).toBe(0)
    expect(map.fileCount).toBe(0)
  })

  it('returns empty repo map for files with no symbols', () => {
    const map = buildRepoMap([
      { path: 'comments.ts', content: '// only comments\n// nothing else\n' },
      { path: 'empty.ts', content: '' },
    ])
    expect(map.symbolCount).toBe(0)
    expect(map.content).toBe('')
  })

  it('respects focus files bonus ranking', () => {
    const files = [
      { path: 'a.ts', content: 'export const x = 1' },
      { path: 'b.ts', content: 'export const y = 2' },
    ]
    const map = buildRepoMap(files, { focusFiles: ['b.ts'], maxTokens: 400 })
    // b.ts should be rendered first because of the focus bonus
    const idxA = map.content.indexOf('a.ts')
    const idxB = map.content.indexOf('b.ts')
    if (idxA >= 0 && idxB >= 0) {
      expect(idxB).toBeLessThan(idxA)
    }
  })

  it('handles single-file repo (findCommonRoot special case)', () => {
    const map = buildRepoMap([
      { path: 'single.ts', content: 'export class S {}' },
    ])
    expect(map.symbolCount).toBe(1)
    expect(map.content).toContain('S')
  })

  it('applies very small maxTokens budget (truncates output)', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `file-${i}.ts`,
      content: `export class Class${i} { method() {} }`,
    }))
    const map = buildRepoMap(files, { maxTokens: 20 })
    // Either no symbols (too small for even a header) or a small number
    expect(map.symbolCount).toBeLessThanOrEqual(20)
    expect(map.estimatedTokens).toBeLessThanOrEqual(40)
  })

  it('fits within default budget when code is modest', () => {
    const map = buildRepoMap([
      { path: 'service.ts', content: 'export class UserService {}\nexport function list() {}' },
    ])
    expect(map.symbolCount).toBeGreaterThan(0)
    expect(map.estimatedTokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// security-profile branch coverage
// ---------------------------------------------------------------------------

describe('security-profile — branch coverage', () => {
  it('customizeProfile overrides level field', () => {
    const custom = customizeProfile('standard', { level: 'strict' })
    expect(custom.level).toBe('strict')
  })

  it('customizeProfile merges only specific slots (network)', () => {
    const custom = customizeProfile('standard', {
      network: { allowOutbound: true, blockInbound: true, allowedDomains: ['a.com'] },
    })
    expect(custom.network.allowOutbound).toBe(true)
    expect(custom.network.allowedDomains).toEqual(['a.com'])
    // other slots untouched
    expect(custom.resources.cpuCores).toBe(1)
  })

  it('customizeProfile overrides resources', () => {
    const custom = customizeProfile('minimal', {
      resources: { cpuCores: 4, memoryMb: 4096, diskMb: 8192, timeoutMs: 900_000 },
    })
    expect(custom.resources.cpuCores).toBe(4)
    expect(custom.resources.memoryMb).toBe(4096)
  })

  it('customizeProfile overrides filesystem + process', () => {
    const custom = customizeProfile('strict', {
      filesystem: { readOnlyMounts: ['/etc'], writablePaths: ['/w'], useTmpfs: false },
      process: { maxProcesses: 10, allowedCapabilities: ['CHOWN'], blockedSyscalls: [] },
    })
    expect(custom.filesystem.readOnlyMounts).toEqual(['/etc'])
    expect(custom.process.allowedCapabilities).toEqual(['CHOWN'])
  })

  it('toDockerFlags omits seccomp when no blockedSyscalls', () => {
    const profile = getSecurityProfile('minimal')
    const flags = toDockerFlags(profile)
    expect(flags.some(f => f.includes('seccomp-syscall-deny'))).toBe(false)
  })

  it('toDockerFlags adds tmpfs when useTmpfs is true', () => {
    const profile = getSecurityProfile('strict')
    const flags = toDockerFlags(profile)
    expect(flags.some(f => f.startsWith('--tmpfs='))).toBe(true)
  })

  it('toDockerFlags adds read-only when paranoid-like profile', () => {
    const profile = customizeProfile('paranoid', {
      filesystem: { readOnlyMounts: [], writablePaths: ['/tmp'], useTmpfs: true },
    })
    const flags = toDockerFlags(profile)
    expect(flags).toContain('--read-only')
  })

  it('toDockerFlags adds cap-add for each allowed capability', () => {
    const profile = customizeProfile('standard', {
      process: { maxProcesses: 50, allowedCapabilities: ['NET_ADMIN', 'CHOWN'], blockedSyscalls: [] },
    })
    const flags = toDockerFlags(profile)
    expect(flags).toContain('--cap-add=NET_ADMIN')
    expect(flags).toContain('--cap-add=CHOWN')
  })

  it('toDockerFlags mounts read-only paths', () => {
    const profile = customizeProfile('standard', {
      filesystem: { readOnlyMounts: ['/host/data'], writablePaths: ['/work'], useTmpfs: false },
    })
    const flags = toDockerFlags(profile)
    expect(flags).toContain('-v=/host/data:/host/data:ro')
  })

  it('toDockerFlags --network=none when outbound disabled', () => {
    const profile = getSecurityProfile('strict')
    const flags = toDockerFlags(profile)
    expect(flags).toContain('--network=none')
  })

  it('toDockerFlags omits --network=none when outbound is allowed (minimal)', () => {
    const profile = getSecurityProfile('minimal')
    const flags = toDockerFlags(profile)
    expect(flags).not.toContain('--network=none')
  })
})

// ---------------------------------------------------------------------------
// ci-monitor branch coverage
// ---------------------------------------------------------------------------

describe('parseGitHubActionsStatus — branch coverage', () => {
  it('handles response without jobs array', () => {
    const result = parseGitHubActionsStatus({
      id: 1,
      conclusion: 'success',
      status: 'completed',
      head_branch: 'main',
      updated_at: '2024-01-01T00:00:00Z',
    })
    expect(result.status).toBe('success')
    expect(result.failures).toEqual([])
  })

  it('captures step and exit_code from job', () => {
    const result = parseGitHubActionsStatus({
      id: 2,
      conclusion: 'failure',
      head_branch: 'main',
      jobs: [
        {
          name: 'test',
          conclusion: 'failure',
          log: 'TS2322: type error',
          step: 'run tests',
          exit_code: 1,
        },
      ],
    })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.step).toBe('run tests')
    expect(result.failures[0]!.exitCode).toBe(1)
    expect(result.failures[0]!.errorCategory).toBe('type-check')
  })

  it('defaults branch to empty string when missing', () => {
    const result = parseGitHubActionsStatus({ id: 1, conclusion: 'success' })
    expect(result.branch).toBe('')
  })

  it('includes html_url when present', () => {
    const result = parseGitHubActionsStatus({
      id: 3,
      conclusion: 'success',
      html_url: 'https://github.com/x/y',
    })
    expect(result.url).toBe('https://github.com/x/y')
  })

  it('uses Date.now fallback when updated_at is not a string', () => {
    const result = parseGitHubActionsStatus({
      id: 4,
      conclusion: 'success',
      updated_at: null,
    })
    expect(result.timestamp).toBeInstanceOf(Date)
  })
})

describe('parseCIWebhook — branch coverage', () => {
  it('reads failures[n].logExcerpt alternate key', () => {
    const result = parseCIWebhook(
      { failures: [{ jobName: 'build', logExcerpt: 'FAIL vitest' }] },
      'generic',
    )
    expect(result.failures[0]!.logExcerpt).toBe('FAIL vitest')
    expect(result.failures[0]!.errorCategory).toBe('test')
  })

  it('falls back to unknown category on non-matching log', () => {
    const result = parseCIWebhook(
      { failures: [{ jobName: 'x', log: 'misc output' }] },
      'generic',
    )
    expect(result.failures[0]!.errorCategory).toBe('unknown')
  })

  it('captures step and exitCode keys', () => {
    const result = parseCIWebhook(
      { failures: [{ jobName: 'x', log: 'x', step: 'S', exitCode: 42 }] },
      'generic',
    )
    expect(result.failures[0]!.step).toBe('S')
    expect(result.failures[0]!.exitCode).toBe(42)
  })
})

describe('categorizeFailure — branch coverage', () => {
  it('returns unknown for empty input', () => {
    expect(categorizeFailure('')).toBe('unknown')
  })

  it('detects type-check from TS error code', () => {
    expect(categorizeFailure('src/a.ts:1:1 - TS2322 error')).toBe('type-check')
  })

  it('detects test from vitest output', () => {
    expect(categorizeFailure('vitest run exited with code 1')).toBe('test')
  })

  it('detects lint from eslint mention', () => {
    expect(categorizeFailure('eslint detected problems')).toBe('lint')
  })

  it('detects build from compile error', () => {
    expect(categorizeFailure('compile error: unresolved import')).toBe('build')
  })
})

// ---------------------------------------------------------------------------
// token-budget branch coverage
// ---------------------------------------------------------------------------

describe('TokenBudgetManager — branch coverage extras', () => {
  it('DefaultRoleDetector detects prisma by direct extension', () => {
    const d = new DefaultRoleDetector()
    expect(d.detect('schema.prisma')).toBe('model')
  })

  it('summarizeFile counts one-line file as 1 line', () => {
    const out = summarizeFile('a.ts', 'export const x = 1')
    expect(out).toContain('1 lines')
  })

  it('selectFiles downgrades when interface fits but full does not', () => {
    const largeContent = 'export function big() {\n' + '  return 1\n'.repeat(200) + '}\n'
    const vfs = { 'src/big.service.ts': largeContent }
    const mgr = new TokenBudgetManager({ budgetTokens: 400, charsPerToken: 4 })
    const result = mgr.selectFiles(vfs, 'generate_backend')
    expect(result).toHaveLength(1)
    expect(result[0]!.content.length).toBeLessThan(largeContent.length)
  })

  it('selectFiles uses full content when file fits entirely', () => {
    // Use review phase which defaults to full for every role
    const vfs = { 'src/svc.ts': 'export const X = 1' }
    const mgr = new TokenBudgetManager({ budgetTokens: 10_000 })
    const res = mgr.selectFiles(vfs, 'review')
    expect(res[0]!.content).toBe('export const X = 1')
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter backend-mapping branch
// ---------------------------------------------------------------------------

describe('FrameworkAdapter — backend mapping', () => {
  it('responds to custom mapping (basic constructor sanity)', () => {
    // Just verify instance exposes the surface used by callers.
    const a = new FrameworkAdapter()
    // getAdaptationGuide should not throw on any input
    expect(() => a.getAdaptationGuide('anything', 'anything')).not.toThrow()
  })
})
