import { describe, it, expect } from 'vitest'
import { InMemoryWorkspaceFS, VirtualFS } from '@dzupagent/codegen'
import { createRenameSymbolTool } from './rename-symbol.tool.js'

const ROOT = '/project'

function makeWorkspace(seed: Record<string, string>): InMemoryWorkspaceFS {
  const vfs = new VirtualFS()
  for (const [path, content] of Object.entries(seed)) {
    vfs.write(path, content)
  }
  return new InMemoryWorkspaceFS(vfs)
}

describe('createRenameSymbolTool — basic rename', () => {
  it('renames a symbol within a single file', async () => {
    const filePath = '/project/src/foo.ts'
    const ws = makeWorkspace({
      [filePath]: [
        'export function oldName(): string {',
        '  return "hello"',
        '}',
        'const x = oldName()',
        '',
      ].join('\n'),
    })

    const tool = createRenameSymbolTool(ws)
    const result = await tool.invoke({
      filePath,
      oldName: 'oldName',
      newName: 'newName',
      rootDir: ROOT,
    })

    expect(result).toContain('Renamed "oldName" → "newName"')
    expect(result).toContain(filePath)

    const updated = await ws.read(filePath)
    expect(updated).toContain('newName')
    expect(updated).not.toContain('oldName')
  })
})

describe('createRenameSymbolTool — symbol not found', () => {
  it('returns an error when the symbol does not exist in the file', async () => {
    const filePath = '/project/src/bar.ts'
    const ws = makeWorkspace({
      [filePath]: 'export const x = 42\n',
    })

    const tool = createRenameSymbolTool(ws)
    const result = await tool.invoke({
      filePath,
      oldName: 'doesNotExist',
      newName: 'whatever',
      rootDir: ROOT,
    })

    expect(result).toContain('rename_symbol failed')
    expect(result).toContain('doesNotExist')
  })
})
