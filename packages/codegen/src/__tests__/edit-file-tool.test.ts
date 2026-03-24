import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { createEditFileTool } from '../tools/edit-file.tool.js'

/**
 * We test the tool's `_call` directly because LangChain's `DynamicStructuredTool.invoke()`
 * has Zod v4 interop issues with nested array schemas. In production, the LLM generates
 * correctly-typed JSON that passes validation. This is a test-only workaround.
 */
async function callEditTool(
  vfs: VirtualFS,
  args: { filePath: string; edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }> },
): Promise<string> {
  const tool = createEditFileTool(vfs)
  // _call bypasses schema validation and calls the handler directly
  return (tool as unknown as { _call: (args: Record<string, unknown>) => Promise<string> })._call(args)
}

describe('createEditFileTool', () => {
  let vfs: VirtualFS

  beforeEach(() => {
    vfs = new VirtualFS({
      'src/index.ts': 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      'src/utils.ts': 'export function add(a: number, b: number) { return a + b; }\n',
    })
  })

  it('applies a single edit', async () => {
    const result = await callEditTool(vfs, {
      filePath: 'src/index.ts',
      edits: [{ oldText: 'const x = 1;', newText: 'const x = 42;' }],
    })

    expect(result).toContain('Applied 1 edit')
    expect(vfs.read('src/index.ts')).toContain('const x = 42;')
  })

  it('applies multiple edits sequentially', async () => {
    const result = await callEditTool(vfs, {
      filePath: 'src/index.ts',
      edits: [
        { oldText: 'const x = 1;', newText: 'const x = 10;' },
        { oldText: 'const y = 2;', newText: 'const y = 20;' },
      ],
    })

    expect(result).toContain('Applied 2 edits')
    const content = vfs.read('src/index.ts')!
    expect(content).toContain('const x = 10;')
    expect(content).toContain('const y = 20;')
    expect(content).toContain('const z = 3;')
  })

  it('reports error for missing file', async () => {
    const result = await callEditTool(vfs, {
      filePath: 'nonexistent.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    })

    expect(result).toContain('Error: File not found')
  })

  it('reports failed edits when search text not found', async () => {
    const result = await callEditTool(vfs, {
      filePath: 'src/index.ts',
      edits: [{ oldText: 'DOES NOT EXIST', newText: 'replacement' }],
    })

    expect(result).toContain('failed')
    expect(result).toContain('search text not found')
  })

  it('handles partial success (some edits fail)', async () => {
    const result = await callEditTool(vfs, {
      filePath: 'src/index.ts',
      edits: [
        { oldText: 'const x = 1;', newText: 'const x = 10;' },
        { oldText: 'MISSING', newText: 'nope' },
      ],
    })

    expect(result).toContain('Applied 1/2')
    expect(result).toContain('Failed')
    expect(vfs.read('src/index.ts')).toContain('const x = 10;')
  })

  it('supports replaceAll flag', async () => {
    const vfsRepeats = new VirtualFS({ 'src/test.ts': 'foo bar foo baz foo' })
    const result = await callEditTool(vfsRepeats, {
      filePath: 'src/test.ts',
      edits: [{ oldText: 'foo', newText: 'qux', replaceAll: true }],
    })

    expect(result).toContain('Applied 1 edit')
    expect(vfsRepeats.read('src/test.ts')).toBe('qux bar qux baz qux')
  })

  it('creates a tool with correct name and description', () => {
    const tool = createEditFileTool(vfs)
    expect(tool.name).toBe('edit_file')
    expect(tool.description).toContain('Edit an existing file')
  })
})
