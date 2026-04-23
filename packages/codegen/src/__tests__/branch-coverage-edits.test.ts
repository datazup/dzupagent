/**
 * Branch coverage deep-dive for edit-file, multi-edit, lint-validator, write-file.
 *
 * Target branches:
 * - edit-file.tool.ts: long text preview (>60 chars), context/workspace fallback,
 *   workspace read throws, workspace write, replaceAll off path, all edits fail
 * - write-file.tool.ts: workspace success path, workspace error path, no-workspace path
 * - lint-validator.ts: skip non-JS file, block comment followed by slash, nested strings
 */
import { describe, it, expect } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { createEditFileTool } from '../tools/edit-file.tool.js'
import { createWriteFileTool } from '../tools/write-file.tool.js'
import { quickSyntaxCheck } from '../tools/lint-validator.js'
import type { Workspace } from '../workspace/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callEditTool(
  toolOrCtx: VirtualFS | { vfs?: VirtualFS; workspace?: Workspace },
  args: { filePath: string; edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }> },
): Promise<string> {
  const tool = createEditFileTool(toolOrCtx as never)
  return (tool as unknown as { _call: (args: Record<string, unknown>) => Promise<string> })._call(args)
}

function makeFakeWorkspace(files: Record<string, string>, opts?: { readThrows?: boolean; writeThrows?: boolean }): Workspace {
  const store = new Map<string, string>(Object.entries(files))
  return {
    rootDir: '/tmp/fake-ws',
    options: { rootDir: '/tmp/fake-ws' },
    readFile: async (path: string) => {
      if (opts?.readThrows) throw new Error('read blew up')
      const content = store.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    writeFile: async (path: string, content: string) => {
      if (opts?.writeThrows) throw new Error('write blew up')
      store.set(path, content)
    },
    listFiles: async () => [...store.keys()],
    search: async () => [],
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    exists: async (path: string) => store.has(path),
  } as Workspace
}

// ---------------------------------------------------------------------------
// edit-file.tool branch coverage
// ---------------------------------------------------------------------------

describe('createEditFileTool — branch coverage', () => {
  it('truncates very long oldText (>60 chars) in error preview', async () => {
    const vfs = new VirtualFS({ 'a.ts': 'const x = 1' })
    const longOld = 'SOMETHING_' + 'x'.repeat(120)
    const result = await callEditTool(vfs, {
      filePath: 'a.ts',
      edits: [{ oldText: longOld, newText: 'y' }],
    })
    expect(result).toContain('failed')
    // preview should contain the ellipsis
    expect(result).toContain('...')
  })

  it('returns all-edits-failed when every edit misses', async () => {
    const vfs = new VirtualFS({ 'a.ts': 'const x = 1' })
    const result = await callEditTool(vfs, {
      filePath: 'a.ts',
      edits: [
        { oldText: 'NOPE1', newText: 'x' },
        { oldText: 'NOPE2', newText: 'x' },
      ],
    })
    expect(result).toMatch(/All 2 edits failed/)
  })

  it('uses workspace.readFile when workspace context is provided', async () => {
    const ws = makeFakeWorkspace({ 'src/a.ts': 'hello world' })
    const result = await callEditTool({ workspace: ws }, {
      filePath: 'src/a.ts',
      edits: [{ oldText: 'hello', newText: 'goodbye' }],
    })
    expect(result).toContain('Applied 1 edit')
    expect(await ws.readFile('src/a.ts')).toBe('goodbye world')
  })

  it('returns not-found when workspace.readFile throws', async () => {
    const ws = makeFakeWorkspace({}, { readThrows: true })
    const result = await callEditTool({ workspace: ws }, {
      filePath: 'src/ghost.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    })
    expect(result).toContain('File not found')
  })

  it('handles neither workspace nor vfs gracefully', async () => {
    const result = await callEditTool({}, {
      filePath: 'src/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    })
    expect(result).toContain('File not found')
  })

  it('reports single edit applied (no plural) correctly', async () => {
    const vfs = new VirtualFS({ 'a.ts': 'foo' })
    const result = await callEditTool(vfs, {
      filePath: 'a.ts',
      edits: [{ oldText: 'foo', newText: 'bar' }],
    })
    expect(result).toMatch(/Applied 1 edit\b/)
    expect(result).not.toMatch(/Applied 1 edits/)
  })

  it('replaceAll=false only replaces first occurrence', async () => {
    const vfs = new VirtualFS({ 'a.ts': 'foo foo foo' })
    await callEditTool(vfs, {
      filePath: 'a.ts',
      edits: [{ oldText: 'foo', newText: 'bar', replaceAll: false }],
    })
    expect(vfs.read('a.ts')).toBe('bar foo foo')
  })

  it('sequential edits where second edit depends on first', async () => {
    const vfs = new VirtualFS({ 'a.ts': 'alpha' })
    const result = await callEditTool(vfs, {
      filePath: 'a.ts',
      edits: [
        { oldText: 'alpha', newText: 'beta' },
        { oldText: 'beta', newText: 'gamma' },
      ],
    })
    expect(result).toContain('Applied 2 edits')
    expect(vfs.read('a.ts')).toBe('gamma')
  })
})

// ---------------------------------------------------------------------------
// write-file.tool branch coverage
// ---------------------------------------------------------------------------

async function invokeWrite(tool: ReturnType<typeof createWriteFileTool>, args: unknown): Promise<string> {
  return (tool as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(args)
}

describe('createWriteFileTool — branch coverage', () => {
  it('returns success without workspace (fallback path)', async () => {
    const tool = createWriteFileTool()
    const raw = await invokeWrite(tool, { filePath: 'src/a.ts', content: 'hello' })
    const parsed = JSON.parse(raw) as { success: boolean; size: number; filePath: string }
    expect(parsed.success).toBe(true)
    expect(parsed.size).toBe(5)
    expect(parsed.filePath).toBe('src/a.ts')
  })

  it('writes through workspace when available', async () => {
    const ws = makeFakeWorkspace({})
    const tool = createWriteFileTool({ workspace: ws })
    const raw = await invokeWrite(tool, { filePath: 'src/new.ts', content: 'data' })
    const parsed = JSON.parse(raw) as { success: boolean }
    expect(parsed.success).toBe(true)
    expect(await ws.readFile('src/new.ts')).toBe('data')
  })

  it('captures workspace.writeFile errors', async () => {
    const ws = makeFakeWorkspace({}, { writeThrows: true })
    const tool = createWriteFileTool({ workspace: ws })
    const raw = await invokeWrite(tool, { filePath: 'src/bad.ts', content: 'x' })
    const parsed = JSON.parse(raw) as { success: boolean; error: string }
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain('write blew up')
  })

  it('handles non-Error workspace write throws (string rejection)', async () => {
    const ws = {
      ...makeFakeWorkspace({}),
      writeFile: async () => {
        return Promise.reject('primitive failure')
      },
    } as Workspace
    const tool = createWriteFileTool({ workspace: ws })
    const raw = await invokeWrite(tool, { filePath: 'x.ts', content: 'y' })
    const parsed = JSON.parse(raw) as { success: boolean; error: string }
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBe('primitive failure')
  })
})

// ---------------------------------------------------------------------------
// lint-validator.ts branch coverage
// ---------------------------------------------------------------------------

describe('quickSyntaxCheck — branch coverage', () => {
  it('skips files with no extension', () => {
    const result = quickSyntaxCheck('LICENSE', '}{}[{')
    expect(result.valid).toBe(true)
  })

  it('skips .json files', () => {
    const result = quickSyntaxCheck('package.json', '{{ ]')
    expect(result.valid).toBe(true)
  })

  it('accepts escaped quote inside string', () => {
    const code = `const s = "hello \\"world\\""\n`
    const result = quickSyntaxCheck('s.ts', code)
    expect(result.valid).toBe(true)
  })

  it('accepts escaped backtick inside template literal', () => {
    const code = 'const s = `tick\\`inside`\n'
    const result = quickSyntaxCheck('s.ts', code)
    expect(result.valid).toBe(true)
  })

  it('closes block comment and continues to detect later issues', () => {
    const code = `/* start */const x = 1;\n// end\n}` // extra close brace after comment
    const result = quickSyntaxCheck('s.ts', code)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Unexpected closing brace'))).toBe(true)
  })

  it('detects unexpected closing paren', () => {
    const result = quickSyntaxCheck('s.ts', 'const x = 1))')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('Unexpected closing paren'))).toBe(true)
  })

  it('detects multiple unclosed brackets', () => {
    const result = quickSyntaxCheck('s.ts', 'const a = [[[')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.message.includes('unclosed bracket'))).toBe(true)
  })

  it('detects unclosed parens in addition to braces', () => {
    const result = quickSyntaxCheck('s.ts', 'function f(a, b, {')
    expect(result.valid).toBe(false)
    // Has at least one unclosed paren or brace
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('valid JSX-like tsx file', () => {
    const code = `export function C() { return <div>hi</div>; }\n`
    const result = quickSyntaxCheck('C.tsx', code)
    expect(result.valid).toBe(true)
  })

  it('valid jsx file', () => {
    const code = `export function C() { return 1; }\n`
    const result = quickSyntaxCheck('C.jsx', code)
    expect(result.valid).toBe(true)
  })

  it('valid .vue file with simple content', () => {
    const code = `export default { name: 'X' }\n`
    const result = quickSyntaxCheck('C.vue', code)
    expect(result.valid).toBe(true)
  })

  it('valid .js file', () => {
    const result = quickSyntaxCheck('C.js', 'const x = 1;')
    expect(result.valid).toBe(true)
  })
})
