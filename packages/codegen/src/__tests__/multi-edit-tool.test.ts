import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { createMultiEditTool } from '../tools/multi-edit.tool.js'

/** Call tool's _call directly — bypasses LangChain Zod v4 nested schema validation */
async function callMultiEdit(
  vfs: VirtualFS,
  args: { fileEdits: Array<{ filePath: string; edits: Array<{ oldText: string; newText: string }> }> },
): Promise<string> {
  const tool = createMultiEditTool(vfs)
  return (tool as unknown as { _call: (args: Record<string, unknown>) => Promise<string> })._call(args)
}

describe('createMultiEditTool', () => {
  let vfs: VirtualFS

  beforeEach(() => {
    vfs = new VirtualFS({
      'src/a.ts': 'import { x } from "./b"\nconst a = x + 1\n',
      'src/b.ts': 'export const x = 1\n',
      'src/c.ts': 'console.log("hello")\n',
    })
  })

  it('applies edits to multiple files', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [{ oldText: 'const a = x + 1', newText: 'const a = x + 2' }],
        },
        {
          filePath: 'src/b.ts',
          edits: [{ oldText: 'export const x = 1', newText: 'export const x = 42' }],
        },
      ],
    })

    expect(result).toContain('Applied edits to 2 files')
    expect(vfs.read('src/a.ts')).toContain('x + 2')
    expect(vfs.read('src/b.ts')).toContain('x = 42')
  })

  it('skips missing files without blocking other edits', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'nonexistent.ts',
          edits: [{ oldText: 'a', newText: 'b' }],
        },
        {
          filePath: 'src/c.ts',
          edits: [{ oldText: 'hello', newText: 'world' }],
        },
      ],
    })

    expect(result).toContain('Applied edits to 1 file')
    expect(result).toContain('skipped (file not found)')
    expect(vfs.read('src/c.ts')).toContain('world')
  })

  it('reports when all edits fail', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: 'src/a.ts',
          edits: [{ oldText: 'DOES NOT EXIST', newText: 'nope' }],
        },
      ],
    })

    expect(result).toContain('No edits applied')
    expect(result).toContain('all edits failed')
    expect(vfs.read('src/a.ts')).toContain('const a = x + 1')
  })

  it('handles partial edit failures within a file', async () => {
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

  it('creates a tool with correct name', () => {
    const tool = createMultiEditTool(vfs)
    expect(tool.name).toBe('multi_edit')
  })
})
