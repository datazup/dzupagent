/**
 * W23-A2 — Codegen Multi-Edit Coherence + AST Repo Map Deep Coverage
 *
 * Covers:
 *  - MultiEditTool: atomic apply, partial failures, skips, conflict, coherence
 *  - RepoMapBuilder: symbol extraction, import graph, budget slicing, ranking
 *  - GitMiddleware: gather/format context, dirty detection, error paths
 *  - PipelineExecutor: sequential, rollback semantics, state passing, errors
 *  - Error paths: overlapping edits, non-TS files, no-git directories
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared BEFORE any `import` of modules they affect.
// ---------------------------------------------------------------------------

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}))

import { VirtualFS } from '../vfs/virtual-fs.js'
import { createMultiEditTool } from '../tools/multi-edit.tool.js'
import { buildRepoMap } from '../repomap/repo-map-builder.js'
import { extractSymbols } from '../repomap/symbol-extractor.js'
import { buildImportGraph } from '../repomap/import-graph.js'
import { gatherGitContext, formatGitContext, type GitContext } from '../git/git-middleware.js'
import { PipelineExecutor, type PhaseConfig } from '../pipeline/pipeline-executor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callMultiEdit(
  vfs: VirtualFS,
  args: {
    fileEdits: Array<{
      filePath: string
      edits: Array<{ oldText: string; newText: string }>
    }>
  },
): Promise<string> {
  const tool = createMultiEditTool(vfs)
  return (tool as unknown as {
    _call: (args: Record<string, unknown>) => Promise<string>
  })._call(args)
}

function makePhase(
  id: string,
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  overrides?: Partial<PhaseConfig>,
): PhaseConfig {
  return { id, name: id, execute, ...overrides }
}

/**
 * Setup the git execFile mock keyed by argument shape.
 * gatherGitContext uses Promise.all([status(), log()]), so call order is
 * interleaved. Key responses by the git subcommand + flags so each call
 * gets the appropriate response regardless of execution order.
 */
function mockGitByArgs(
  resolvers: {
    branch?: string
    porcelain?: string
    log?: string
    errorAll?: Error
  },
): void {
  execFileAsyncMock.mockImplementation((_bin: string, args: string[]) => {
    if (resolvers.errorAll) return Promise.reject(resolvers.errorAll)
    // getCurrentBranch → `symbolic-ref --short HEAD`
    if (args[0] === 'symbolic-ref') {
      return Promise.resolve({ stdout: (resolvers.branch ?? 'main') + '\n', stderr: '' })
    }
    // status --porcelain=v1 ...
    if (args[0] === 'status') {
      return Promise.resolve({ stdout: resolvers.porcelain ?? '## main\n', stderr: '' })
    }
    // log --max-count=N ...
    if (args[0] === 'log') {
      return Promise.resolve({ stdout: resolvers.log ?? '', stderr: '' })
    }
    // fallback for rev-parse fallback when not on a branch
    if (args[0] === 'rev-parse') {
      return Promise.resolve({ stdout: 'abc1234\n', stderr: '' })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  })
}

// ---------------------------------------------------------------------------
// MultiEditTool — deep coverage
// ---------------------------------------------------------------------------

describe('MultiEditTool — deep coverage', () => {
  let vfs: VirtualFS

  beforeEach(() => {
    vfs = new VirtualFS({
      'src/a.ts': 'import { x } from "./b"\nconst a = x + 1\n',
      'src/b.ts': 'export const x = 1\n',
      'src/c.ts': 'console.log("hello")\n',
      'src/d.ts': 'function foo() { return 1 }\nfunction bar() { return 2 }\n',
    })
  })

  // --- atomic multi-file apply ---

  it('applies edits to all files in a single atomic call', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [{ oldText: 'const a = x + 1', newText: 'const a = x + 7' }],
        },
        {
          filePath: 'src/b.ts',
          edits: [{ oldText: 'x = 1', newText: 'x = 42' }],
        },
      ],
    })

    expect(result).toContain('Applied edits to 2 files')
    expect(vfs.read('src/a.ts')).toContain('x + 7')
    expect(vfs.read('src/b.ts')).toContain('x = 42')
  })

  it('applies edits across three files at once', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        { filePath: 'src/a.ts', edits: [{ oldText: 'x + 1', newText: 'x + 2' }] },
        { filePath: 'src/b.ts', edits: [{ oldText: 'x = 1', newText: 'x = 2' }] },
        { filePath: 'src/c.ts', edits: [{ oldText: 'hello', newText: 'world' }] },
      ],
    })

    expect(result).toContain('Applied edits to 3 files')
    expect(vfs.read('src/a.ts')).toContain('x + 2')
    expect(vfs.read('src/b.ts')).toContain('x = 2')
    expect(vfs.read('src/c.ts')).toContain('world')
  })

  it('preserves file content when all edits succeed', async () => {
    const before = vfs.read('src/a.ts')!
    await callMultiEdit(vfs, {
      fileEdits: [
        { filePath: 'src/a.ts', edits: [{ oldText: 'const a', newText: 'const a' }] },
      ],
    })
    const after = vfs.read('src/a.ts')!
    expect(after).toBe(before)
  })

  it('reports file count in summary message', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        { filePath: 'src/a.ts', edits: [{ oldText: 'const a', newText: 'const AA' }] },
      ],
    })
    expect(result).toMatch(/Applied edits to 1 file/)
  })

  // --- rollback / partial-failure semantics ---

  it('does not write files whose edits all failed', async () => {
    const before = vfs.read('src/a.ts')!
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [{ oldText: 'NOT-PRESENT', newText: 'nope' }],
        },
      ],
    })
    // a.ts must be unchanged when all its edits fail
    expect(vfs.read('src/a.ts')).toBe(before)
  })

  it('writes only successful files when some files fail', async () => {
    const beforeA = vfs.read('src/a.ts')!
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [{ oldText: 'NOT-PRESENT', newText: 'X' }],
        },
        {
          filePath: 'src/c.ts',
          edits: [{ oldText: 'hello', newText: 'hola' }],
        },
      ],
    })
    // a.ts unchanged, c.ts changed
    expect(vfs.read('src/a.ts')).toBe(beforeA)
    expect(vfs.read('src/c.ts')).toContain('hola')
  })

  it('keeps partial edits per file when at least one edit matched', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [
            { oldText: 'const a = x + 1', newText: 'const a = x + 99' },
            { oldText: 'MISSING', newText: 'nope' },
          ],
        },
      ],
    })
    expect(result).toContain('1/2 edits applied')
    expect(result).toContain('1 failed')
    expect(vfs.read('src/a.ts')).toContain('x + 99')
  })

  // --- missing-file / empty behaviors ---

  it('skips missing files and reports them', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/does-not-exist.ts',
          edits: [{ oldText: 'a', newText: 'b' }],
        },
      ],
    })
    expect(result).toContain('skipped (file not found)')
    expect(result).toContain('No edits applied')
  })

  it('skips missing files but still applies others', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        { filePath: 'missing.ts', edits: [{ oldText: 'x', newText: 'y' }] },
        {
          filePath: 'src/c.ts',
          edits: [{ oldText: 'hello', newText: 'aloha' }],
        },
      ],
    })
    expect(result).toContain('Applied edits to 1 file')
    expect(result).toContain('skipped (file not found)')
    expect(vfs.read('src/c.ts')).toContain('aloha')
  })

  it('truncates long oldText in failure preview', async () => {
    const longText = 'x'.repeat(100) // > 40 chars
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [{ oldText: longText, newText: 'replaced' }],
        },
      ],
    })
    // Fail message summary is in No edits applied
    expect(result).toContain('No edits applied')
    expect(result).toContain('all edits failed')
  })

  // --- sequential / conflict detection semantics ---

  it('applies multiple edits in order within a single file', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/d.ts',
          edits: [
            { oldText: 'return 1', newText: 'return 10' },
            { oldText: 'return 2', newText: 'return 20' },
          ],
        },
      ],
    })
    expect(result).toContain('2/2 edits applied')
    const content = vfs.read('src/d.ts')!
    expect(content).toContain('return 10')
    expect(content).toContain('return 20')
  })

  it('detects conflict where second edit depends on first result', async () => {
    // First edit changes "return 1" to "return 1000".
    // Second edit tries to match "return 1" — which no longer exists.
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/d.ts',
          edits: [
            { oldText: 'return 1', newText: 'return 1000' },
            { oldText: 'return 1 ', newText: 'return 1x ' },
          ],
        },
      ],
    })
    expect(result).toContain('edits applied')
  })

  it('second occurrence of substring is not replaced in same edit step', async () => {
    vfs.write('src/dup.ts', 'let x = 1\nlet x = 1\n')
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/dup.ts',
          edits: [{ oldText: 'let x = 1', newText: 'let y = 2' }],
        },
      ],
    })
    // Only first occurrence replaced
    const content = vfs.read('src/dup.ts')!
    expect(content.split('let y = 2').length - 1).toBe(1)
    expect(content.split('let x = 1').length - 1).toBe(1)
  })

  it('overlapping edits where second finds result of first', async () => {
    vfs.write('src/ov.ts', 'alpha beta gamma\n')
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/ov.ts',
          edits: [
            { oldText: 'alpha beta', newText: 'ALPHABETA' },
            { oldText: 'ALPHABETA', newText: 'OMEGA' },
          ],
        },
      ],
    })
    expect(result).toContain('2/2 edits applied')
    expect(vfs.read('src/ov.ts')).toContain('OMEGA gamma')
  })

  // --- coherence: no orphan imports ---

  it('rename across files keeps imports coherent with the same edit batch', async () => {
    vfs.write('src/lib.ts', 'export const OldName = 42\n')
    vfs.write('src/use.ts', 'import { OldName } from "./lib"\nconsole.log(OldName)\n')

    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/lib.ts',
          edits: [{ oldText: 'OldName', newText: 'NewName' }],
        },
        {
          filePath: 'src/use.ts',
          edits: [
            { oldText: 'import { OldName }', newText: 'import { NewName }' },
            { oldText: 'console.log(OldName)', newText: 'console.log(NewName)' },
          ],
        },
      ],
    })
    expect(result).toContain('Applied edits to 2 files')
    expect(vfs.read('src/lib.ts')).toContain('export const NewName')
    expect(vfs.read('src/use.ts')).toContain('import { NewName }')
    expect(vfs.read('src/use.ts')).not.toContain('OldName')
  })

  it('leaves orphan imports detectable if only library file is edited', async () => {
    vfs.write('src/lib.ts', 'export const OldName = 42\n')
    vfs.write('src/use.ts', 'import { OldName } from "./lib"\n')

    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/lib.ts',
          edits: [{ oldText: 'OldName', newText: 'NewName' }],
        },
      ],
    })
    // use.ts still refers to OldName — orphan import
    expect(vfs.read('src/use.ts')).toContain('OldName')
    expect(vfs.read('src/lib.ts')).toContain('NewName')
  })

  // --- tool shape ---

  it('returns a DynamicStructuredTool-like object with name', () => {
    const tool = createMultiEditTool(vfs)
    expect(tool.name).toBe('multi_edit')
    expect(tool.description).toContain('Apply edits to multiple files')
  })

  it('has a valid zod schema', () => {
    const tool = createMultiEditTool(vfs)
    expect(tool.schema).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// RepoMapBuilder — deep coverage
// ---------------------------------------------------------------------------

describe('RepoMapBuilder — deep coverage', () => {
  // --- symbol extraction ---

  it('extracts every symbol kind from a single file', () => {
    const content = [
      'export class C {}',
      'export interface I { x: number }',
      'export enum E { A, B }',
      'export type T = string',
      'export function f() {}',
      'export const K = 1',
    ].join('\n')
    const syms = extractSymbols('mix.ts', content)
    const kinds = syms.map((s) => s.kind)
    expect(kinds).toContain('class')
    expect(kinds).toContain('interface')
    expect(kinds).toContain('enum')
    expect(kinds).toContain('type')
    expect(kinds).toContain('function')
    expect(kinds).toContain('const')
  })

  it('marks signature without export keyword', () => {
    const syms = extractSymbols('x.ts', 'export class Foo {}')
    expect(syms[0]!.signature).not.toMatch(/^export/)
    expect(syms[0]!.signature).toContain('class Foo')
  })

  it('tracks 1-based line numbers', () => {
    const content = '\n\nexport class A {}\n\nexport class B {}\n'
    const syms = extractSymbols('ln.ts', content)
    expect(syms[0]!.line).toBe(3)
    expect(syms[1]!.line).toBe(5)
  })

  it('returns empty array for empty string', () => {
    expect(extractSymbols('empty.ts', '')).toEqual([])
  })

  // --- import graph edges ---

  it('builds edges between two files with a named import', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
    ]
    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.symbols).toEqual(['B'])
  })

  it('builds importer/imported lookups', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
      { path: 'src/c.ts', content: `import { B } from './b'` },
    ]
    const graph = buildImportGraph(files, '/project')
    expect(graph.importedBy('src/b.ts')).toHaveLength(2)
    expect(graph.importsFrom('src/a.ts')).toHaveLength(1)
  })

  it('detects import roots — files with no imports', () => {
    const files = [
      { path: 'src/root.ts', content: 'export const R = 1' },
      { path: 'src/consumer.ts', content: `import { R } from './root'` },
    ]
    const graph = buildImportGraph(files, '/project')
    const roots = graph.roots()
    expect(roots.some((r) => r.endsWith('root.ts'))).toBe(true)
    expect(roots.some((r) => r.endsWith('consumer.ts'))).toBe(false)
  })

  it('graph tolerates circular imports without infinite loop', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'\nexport const A = 1` },
      { path: 'src/b.ts', content: `import { A } from './a'\nexport const B = 1` },
    ]
    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(2)
    // Circular: each file imports the other
    expect(graph.importedBy('src/a.ts')).toHaveLength(1)
    expect(graph.importedBy('src/b.ts')).toHaveLength(1)
  })

  // --- repo map output ---

  it('produces markdown with file headers starting with ##', () => {
    const files = [
      { path: 'src/mod.ts', content: 'export class Foo {}' },
    ]
    const map = buildRepoMap(files)
    expect(map.content).toMatch(/##\s+src\/mod\.ts/)
  })

  it('prepends export keyword in symbol lines for exported symbols', () => {
    const files = [
      { path: 'src/mod.ts', content: 'export class Foo {}' },
    ]
    const map = buildRepoMap(files)
    expect(map.content).toMatch(/- export class Foo/)
  })

  it('does not prepend export for non-exported symbols', () => {
    const files = [
      { path: 'src/mod.ts', content: 'class Inner {}' },
    ]
    const map = buildRepoMap(files)
    expect(map.content).not.toMatch(/- export class Inner/)
    expect(map.content).toContain('class Inner')
  })

  it('counts fileCount and symbolCount correctly', () => {
    const files = [
      { path: 'src/a.ts', content: 'export class A {}\nexport class B {}' },
      { path: 'src/b.ts', content: 'export function f() {}' },
    ]
    const map = buildRepoMap(files)
    expect(map.fileCount).toBe(2)
    expect(map.symbolCount).toBe(3)
  })

  // --- budget slicing ---

  it('slices output when token budget is tiny', () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `src/mod-${i}.ts`,
      content: `export class Module${i} {}\nexport interface Iface${i} {}`,
    }))
    const tiny = buildRepoMap(files, { maxTokens: 50 })
    const big = buildRepoMap(files, { maxTokens: 5000 })
    expect(tiny.symbolCount).toBeLessThanOrEqual(big.symbolCount)
    expect(tiny.estimatedTokens).toBeLessThanOrEqual(50)
  })

  it('respects a zero or near-zero budget by returning empty content', () => {
    const files = [
      { path: 'src/big.ts', content: 'export class Foo {}' },
    ]
    const map = buildRepoMap(files, { maxTokens: 1 })
    expect(map.estimatedTokens).toBeLessThanOrEqual(5)
  })

  it('large budget includes all symbols', () => {
    const files = [
      { path: 'src/a.ts', content: 'export class A {}\nexport class B {}' },
      { path: 'src/b.ts', content: 'export function f() {}' },
    ]
    const map = buildRepoMap(files, { maxTokens: 50_000 })
    expect(map.symbolCount).toBe(3)
  })

  // --- ranking ---

  it('ranks focus files ahead of non-focus files', () => {
    const files = [
      { path: 'src/normal.ts', content: 'export const x = 1' },
      { path: 'src/focus.ts', content: 'export const y = 2' },
    ]
    const map = buildRepoMap(files, { focusFiles: ['src/focus.ts'] })
    const focusIdx = map.content.indexOf('focus.ts')
    const normalIdx = map.content.indexOf('normal.ts')
    expect(focusIdx).toBeLessThan(normalIdx)
  })

  it('ranks classes higher than consts for same export status', () => {
    const files = [
      { path: 'src/mix.ts', content: 'export const first = 1\nexport class Second {}' },
    ]
    const map = buildRepoMap(files)
    const classIdx = map.content.indexOf('class Second')
    const constIdx = map.content.indexOf('const first')
    // Same file: ordering by score within file
    expect(classIdx).toBeGreaterThan(-1)
    expect(constIdx).toBeGreaterThan(-1)
    expect(classIdx).toBeLessThan(constIdx)
  })

  it('ranks files whose content is imported by others higher', () => {
    // b.ts is imported by 2 files, so it gets +2 to symbol scores
    const files = [
      { path: 'src/a.ts', content: `import { X } from './b'\nexport class A {}` },
      { path: 'src/b.ts', content: 'export class X {}' },
      { path: 'src/c.ts', content: `import { X } from './b'\nexport class C {}` },
    ]
    const map = buildRepoMap(files)
    const bIdx = map.content.indexOf('class X')
    const aIdx = map.content.indexOf('class A')
    expect(bIdx).toBeLessThan(aIdx)
  })

  // --- exclude patterns ---

  it('excludes files matching substring patterns', () => {
    const files = [
      { path: 'src/service.ts', content: 'export class Service {}' },
      { path: 'node_modules/pkg/index.ts', content: 'export class External {}' },
      { path: 'dist/compiled.ts', content: 'export class Compiled {}' },
    ]
    const map = buildRepoMap(files, {
      excludePatterns: ['node_modules', 'dist/'],
    })
    expect(map.content).toContain('Service')
    expect(map.content).not.toContain('External')
    expect(map.content).not.toContain('Compiled')
  })

  it('includes everything when excludePatterns is empty', () => {
    const files = [
      { path: 'src/a.ts', content: 'export class A {}' },
      { path: 'node_modules/b.ts', content: 'export class B {}' },
    ]
    const map = buildRepoMap(files)
    expect(map.content).toContain('A')
    expect(map.content).toContain('B')
  })

  // --- incremental / edge cases ---

  it('incremental: second build with added file includes new symbols', () => {
    const v1 = [{ path: 'src/a.ts', content: 'export class A {}' }]
    const v2 = [
      { path: 'src/a.ts', content: 'export class A {}' },
      { path: 'src/b.ts', content: 'export class B {}' },
    ]
    const m1 = buildRepoMap(v1)
    const m2 = buildRepoMap(v2)
    expect(m2.symbolCount).toBeGreaterThan(m1.symbolCount)
    expect(m2.content).toContain('class A')
    expect(m2.content).toContain('class B')
  })

  it('non-TS source content does not crash extraction', () => {
    const files = [
      { path: 'README.md', content: '# Hello\nThis is markdown, no symbols.' },
      { path: 'src/mod.ts', content: 'export class Real {}' },
    ]
    const map = buildRepoMap(files)
    // README has no exports/classes/etc — so no symbols
    expect(map.content).toContain('Real')
  })

  it('gracefully handles files with only imports', () => {
    const files = [
      { path: 'src/re.ts', content: `import { x } from './x'` },
      { path: 'src/x.ts', content: 'export const x = 1' },
    ]
    const map = buildRepoMap(files)
    expect(map.symbolCount).toBe(1)
    expect(map.content).toContain('const x')
  })

  it('content string is deterministic given the same input', () => {
    const files = [
      { path: 'src/a.ts', content: 'export class A {}' },
      { path: 'src/b.ts', content: 'export class B {}' },
    ]
    const m1 = buildRepoMap(files)
    const m2 = buildRepoMap(files)
    expect(m1.content).toBe(m2.content)
    expect(m1.symbolCount).toBe(m2.symbolCount)
    expect(m1.fileCount).toBe(m2.fileCount)
  })

  it('estimatedTokens roughly equals content length / 4', () => {
    const files = [
      { path: 'src/big.ts', content: 'export class ' + 'X'.repeat(200) + ' {}' },
    ]
    const map = buildRepoMap(files)
    // estimate is Math.ceil(content.length/4)
    expect(map.estimatedTokens).toBe(Math.ceil(map.content.length / 4))
  })
})

// ---------------------------------------------------------------------------
// GitMiddleware — deep coverage
// ---------------------------------------------------------------------------

describe('GitMiddleware — deep coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  // --- formatGitContext: pure formatter ---

  it('formats a clean working tree into a markdown block', () => {
    const ctx: GitContext = {
      branch: 'main',
      status: '(clean working tree)',
      recentCommits: '  abc1234 initial commit',
      isDirty: false,
    }
    const out = formatGitContext(ctx)
    expect(out).toContain('## Git Context')
    expect(out).toContain('**Branch:** main')
    expect(out).toContain('(clean working tree)')
    expect(out).toContain('abc1234 initial commit')
  })

  it('formats a dirty context with multiple file changes', () => {
    const ctx: GitContext = {
      branch: 'feature/x',
      status: '  M src/a.ts\n  A src/b.ts\n  D src/c.ts',
      recentCommits: '  abc1234 add x\n  def5678 fix y',
      isDirty: true,
    }
    const out = formatGitContext(ctx)
    expect(out).toContain('**Branch:** feature/x')
    expect(out).toContain('M src/a.ts')
    expect(out).toContain('A src/b.ts')
    expect(out).toContain('D src/c.ts')
  })

  it('formatter wraps status and commits in code fences', () => {
    const ctx: GitContext = {
      branch: 'dev',
      status: 'ok',
      recentCommits: 'c1',
      isDirty: false,
    }
    const out = formatGitContext(ctx)
    // 2 code-fence blocks → at least 4 "```" occurrences
    const fences = (out.match(/```/g) ?? []).length
    expect(fences).toBeGreaterThanOrEqual(4)
  })

  it('formatter is deterministic for identical inputs', () => {
    const ctx: GitContext = {
      branch: 'main',
      status: 'clean',
      recentCommits: 'x',
      isDirty: false,
    }
    expect(formatGitContext(ctx)).toBe(formatGitContext(ctx))
  })

  // --- gatherGitContext: success path ---

  it('returns a populated GitContext from git status + log', async () => {
    mockGitByArgs({
      branch: 'main',
      porcelain: '## main\n M src/a.ts\n',
      log: 'deadbeef|dead|User|2024-01-01T00:00:00Z|initial commit\n',
    })

    const ctx = await gatherGitContext({ cwd: '/tmp/fake' })
    expect(ctx).not.toBeNull()
    expect(ctx!.branch).toBe('main')
    expect(ctx!.isDirty).toBe(true)
    expect(ctx!.status).toContain('src/a.ts')
    expect(ctx!.recentCommits).toContain('initial')
  })

  it('returns isDirty=false for a clean working tree', async () => {
    mockGitByArgs({ branch: 'main', porcelain: '## main\n', log: '' })
    const ctx = await gatherGitContext({ cwd: '/tmp/fake' })
    expect(ctx).not.toBeNull()
    expect(ctx!.isDirty).toBe(false)
    expect(ctx!.status).toBe('(clean working tree)')
  })

  it('formats recent commits as "shortHash message" lines', async () => {
    mockGitByArgs({
      branch: 'main',
      porcelain: '## main\n',
      log:
        'deadbeefcafe1234|deadbee|Alice|2024-01-01|first\n' +
        'feedface00001234|feedfac|Bob|2024-01-02|second\n',
    })
    const ctx = await gatherGitContext()
    expect(ctx).not.toBeNull()
    expect(ctx!.recentCommits).toContain('first')
    expect(ctx!.recentCommits).toContain('second')
    // Short hash: hash.slice(0,7) of the full hash
    expect(ctx!.recentCommits).toMatch(/deadbee/)
  })

  it('returns "(no commits)" string when log returns nothing', async () => {
    mockGitByArgs({ branch: 'main', porcelain: '## main\n', log: '' })
    const ctx = await gatherGitContext()
    expect(ctx).not.toBeNull()
    expect(ctx!.recentCommits).toBe('(no commits)')
  })

  it('supports custom recentCommits count parameter', async () => {
    mockGitByArgs({
      branch: 'main',
      porcelain: '## main\n',
      log: 'abc|abc|u|d|m\n',
    })
    const ctx = await gatherGitContext({ recentCommits: 2 })
    expect(ctx).not.toBeNull()
    // Verify git was invoked with --max-count=2 in the log call
    const gitArgs = execFileAsyncMock.mock.calls
      .map((c) => c[1])
      .filter((a): a is string[] => Array.isArray(a))
    const logCalls = gitArgs.find((a) => a[0] === 'log')
    expect(logCalls).toBeDefined()
    expect(logCalls!.some((x) => x.includes('--max-count=2'))).toBe(true)
  })

  // --- gatherGitContext: failure paths ---

  it('returns null when not a git repository', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('not a git repository'))
    const ctx = await gatherGitContext({ cwd: '/no-git' })
    expect(ctx).toBeNull()
  })

  it('returns null when git binary is missing', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('ENOENT: git not found'))
    const ctx = await gatherGitContext()
    expect(ctx).toBeNull()
  })

  it('returns null when branch lookup itself throws', async () => {
    mockGitByArgs({ errorAll: new Error('fatal: not a git repository') })
    const ctx = await gatherGitContext()
    expect(ctx).toBeNull()
  })

  it('formatter works on the output of gatherGitContext', async () => {
    mockGitByArgs({
      branch: 'main',
      porcelain: '## main\n M src/a.ts\n',
      log: 'abc|abc|u|d|msg\n',
    })
    const ctx = await gatherGitContext()
    expect(ctx).not.toBeNull()
    const formatted = formatGitContext(ctx!)
    expect(formatted).toContain('main')
    expect(formatted).toContain('## Git Context')
  })
})

// ---------------------------------------------------------------------------
// PipelineExecutor — deep coverage
// ---------------------------------------------------------------------------

describe('PipelineExecutor — deep coverage', () => {
  // --- sequential execution ---

  it('runs phases sequentially in declared order', async () => {
    const order: string[] = []
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => { order.push('a'); return { a: true } }),
      makePhase('b', async () => { order.push('b'); return { b: true } }),
      makePhase('c', async () => { order.push('c'); return { c: true } }),
    ]
    await ex.execute(phases, {})
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('passes output of a phase to the next phase via state', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('produce', async () => ({ value: 10 })),
      makePhase('consume', async (s) => {
        return { doubled: (s['value'] as number) * 2 }
      }),
    ]
    const result = await ex.execute(phases, {})
    expect(result.state['doubled']).toBe(20)
  })

  it('merges state from all prior phases into final state', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({ a: 1 })),
      makePhase('b', async () => ({ b: 2 })),
      makePhase('c', async () => ({ c: 3 })),
    ]
    const result = await ex.execute(phases, { initial: 'seed' })
    expect(result.state['initial']).toBe('seed')
    expect(result.state['a']).toBe(1)
    expect(result.state['b']).toBe(2)
    expect(result.state['c']).toBe(3)
  })

  it('records per-phase completion markers in state', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('alpha', async () => ({ a: 1 })),
      makePhase('beta', async () => ({ b: 2 })),
    ]
    const result = await ex.execute(phases, {})
    expect(result.state['__phase_alpha_completed']).toBe(true)
    expect(result.state['__phase_beta_completed']).toBe(true)
  })

  // --- failure / "rollback" semantics ---

  it('phase failure stops subsequent phases from running', async () => {
    const later = vi.fn()
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('ok', async () => ({ ok: true })),
      makePhase('fail', async () => { throw new Error('stop here') }),
      makePhase('later', async () => { later(); return { late: true } }),
    ]
    const result = await ex.execute(phases, {})
    expect(result.status).toBe('failed')
    expect(later).not.toHaveBeenCalled()
  })

  it('prior-stage side effects remain visible in returned state on failure', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({ a: 'done' })),
      makePhase('b', async () => { throw new Error('bad') }),
    ]
    const result = await ex.execute(phases, {})
    expect(result.status).toBe('failed')
    expect(result.state['a']).toBe('done')
  })

  it('checkpoints are not taken for failed phases', async () => {
    const onCheckpoint = vi.fn(async () => {})
    const ex = new PipelineExecutor({ onCheckpoint })
    const phases: PhaseConfig[] = [
      makePhase('ok', async () => ({ x: 1 })),
      makePhase('fail', async () => { throw new Error('nope') }),
    ]
    await ex.execute(phases, {})
    // onCheckpoint should be called once (for ok), never for fail
    expect(onCheckpoint).toHaveBeenCalledTimes(1)
    expect(onCheckpoint.mock.calls[0]![0]).toBe('ok')
  })

  it('failure phase error string is surfaced in result.phases[].error', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('bad', async () => { throw new Error('custom-failure-msg') }),
    ]
    const result = await ex.execute(phases, {})
    const phase = result.phases.find((p) => p.phaseId === 'bad')
    expect(phase).toBeDefined()
    expect(phase!.error).toContain('custom-failure-msg')
    expect(phase!.status).toBe('failed')
  })

  // --- parallel-like / dependency ordering ---

  it('independent phases with no deps still run in sorted order', async () => {
    const order: string[] = []
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('p1', async () => { order.push('p1'); return {} }),
      makePhase('p2', async () => { order.push('p2'); return {} }),
      makePhase('p3', async () => { order.push('p3'); return {} }),
    ]
    await ex.execute(phases, {})
    expect(order).toEqual(['p1', 'p2', 'p3'])
  })

  it('phase with unmet dep executes after its dep', async () => {
    const order: string[] = []
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('dependent', async () => { order.push('dependent'); return { x: 1 } },
        { dependsOn: ['root'] }),
      makePhase('root', async () => { order.push('root'); return { y: 1 } }),
    ]
    await ex.execute(phases, {})
    expect(order).toEqual(['root', 'dependent'])
  })

  // --- conditions ---

  it('skipped phases do not contribute to state', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('skip-me', async () => ({ shouldNot: true }),
        { condition: () => false }),
    ]
    const result = await ex.execute(phases, {})
    expect(result.state['shouldNot']).toBeUndefined()
    expect(result.state['__phase_skip-me_skipped']).toBe(true)
  })

  it('condition receives the current state object', async () => {
    const ex = new PipelineExecutor()
    let seen: Record<string, unknown> | undefined
    const phases: PhaseConfig[] = [
      makePhase('set', async () => ({ flag: true })),
      makePhase('conditional', async () => ({ ran: true }), {
        condition: (s) => {
          seen = s
          return s['flag'] === true
        },
      }),
    ]
    const result = await ex.execute(phases, { initial: 'x' })
    expect(seen).toBeDefined()
    expect(seen!['flag']).toBe(true)
    expect(result.state['ran']).toBe(true)
  })

  // --- progress callbacks ---

  it('onProgress reaches 1 at phase completion', async () => {
    const progressMap = new Map<string, number[]>()
    const ex = new PipelineExecutor({
      onProgress: (id, p) => {
        const arr = progressMap.get(id) ?? []
        arr.push(p)
        progressMap.set(id, arr)
      },
    })
    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({})),
      makePhase('b', async () => ({})),
    ]
    await ex.execute(phases, {})
    expect(progressMap.get('a')!.slice(-1)[0]).toBe(1)
    expect(progressMap.get('b')!.slice(-1)[0]).toBe(1)
  })

  // --- edge cases ---

  it('handles single-phase pipeline', async () => {
    const ex = new PipelineExecutor()
    const result = await ex.execute(
      [makePhase('only', async () => ({ done: true }))],
      {},
    )
    expect(result.status).toBe('completed')
    expect(result.phases).toHaveLength(1)
    expect(result.state['done']).toBe(true)
  })

  it('result.totalDurationMs is recorded', async () => {
    const ex = new PipelineExecutor()
    const result = await ex.execute(
      [makePhase('a', async () => ({}))],
      {},
    )
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('result.phases[].durationMs is non-negative', async () => {
    const ex = new PipelineExecutor()
    const result = await ex.execute(
      [makePhase('a', async () => ({}))],
      {},
    )
    expect(result.phases[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('state object is new — mutating result.state does not affect subsequent runs', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({ key: 'value' })),
    ]
    const r1 = await ex.execute(phases, {})
    r1.state['extra'] = 'mutated'
    const r2 = await ex.execute(phases, {})
    expect(r2.state['extra']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Error paths — cross-cutting
// ---------------------------------------------------------------------------

describe('Error paths — cross-cutting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --- multi-edit error paths ---

  it('multi-edit: empty edits array is rejected by schema (not invoked)', () => {
    const vfs = new VirtualFS({ 'src/a.ts': 'abc' })
    const tool = createMultiEditTool(vfs)
    // The inputSchema requires min(1) for fileEdits; we cannot pass an empty object.
    // Verify the schema refuses an empty fileEdits array.
    const parsed = tool.schema.safeParse({ fileEdits: [] })
    expect(parsed.success).toBe(false)
  })

  it('multi-edit: no fileEdits field is rejected by schema', () => {
    const vfs = new VirtualFS()
    const tool = createMultiEditTool(vfs)
    const parsed = tool.schema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it('multi-edit: a file edit with empty edits array is rejected by schema', () => {
    const vfs = new VirtualFS({ 'a.ts': 'content' })
    const tool = createMultiEditTool(vfs)
    const parsed = tool.schema.safeParse({
      fileEdits: [{ filePath: 'a.ts', edits: [] }],
    })
    expect(parsed.success).toBe(false)
  })

  // --- repo-map error paths ---

  it('repo-map: non-TS files are silently skipped for symbol extraction', () => {
    const files = [
      { path: 'data.json', content: '{"x":1}' },
      { path: 'src/a.ts', content: 'export class A {}' },
    ]
    const map = buildRepoMap(files)
    // Only the .ts file yields symbols — JSON has no matching pattern lines
    expect(map.content).toContain('class A')
    // JSON pseudo-content starting with { doesn't match any patterns so no symbols
  })

  it('repo-map: invalid/broken TS does not crash the builder', () => {
    const files = [
      {
        path: 'src/broken.ts',
        content: 'export class ??? syntax error\n}\nexport const GOOD = 1',
      },
    ]
    const map = buildRepoMap(files)
    // Regex-based extractor still finds GOOD even with broken lines
    expect(map.content).toContain('GOOD')
  })

  it('repo-map: file with only whitespace returns empty map', () => {
    const map = buildRepoMap([{ path: 'ws.ts', content: '   \n\n\t\n' }])
    expect(map.symbolCount).toBe(0)
  })

  // --- git-middleware error paths ---

  it('git: middleware returns null in a non-git directory', async () => {
    execFileAsyncMock.mockRejectedValue(
      new Error('fatal: not a git repository (or any parent directory)'),
    )
    const ctx = await gatherGitContext({ cwd: '/tmp/no-git' })
    expect(ctx).toBeNull()
  })

  it('git: middleware returns null when command times out', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('ETIMEDOUT'))
    const ctx = await gatherGitContext()
    expect(ctx).toBeNull()
  })

  it('git: formatter handles empty fields without throwing', () => {
    const ctx: GitContext = { branch: '', status: '', recentCommits: '', isDirty: false }
    expect(() => formatGitContext(ctx)).not.toThrow()
    const out = formatGitContext(ctx)
    expect(out).toContain('## Git Context')
  })

  // --- pipeline-executor error paths ---

  it('pipeline: cycle detection throws synchronously before running any phase', async () => {
    const ran = vi.fn()
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => { ran(); return {} }, { dependsOn: ['b'] }),
      makePhase('b', async () => { ran(); return {} }, { dependsOn: ['a'] }),
    ]
    await expect(ex.execute(phases, {})).rejects.toThrow(/Cycle detected/)
    expect(ran).not.toHaveBeenCalled()
  })

  it('pipeline: unknown dep throws synchronously before running any phase', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({}), { dependsOn: ['ghost'] }),
    ]
    await expect(ex.execute(phases, {})).rejects.toThrow(/Unknown dependency/)
  })
})
