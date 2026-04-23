import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRenameSymbolTool, renameSymbol } from './rename-symbol.tool.js'

/**
 * Write a realistic mini TS project (src/a.ts defines a function that
 * src/b.ts imports) rooted at `root` and return the paths we exercise in
 * the tests.
 */
function seedProject(root: string) {
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })

  const tsconfigPath = join(root, 'tsconfig.json')
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  )

  const aPath = join(srcDir, 'a.ts')
  writeFileSync(
    aPath,
    [
      'export function oldName(): string {',
      '  return "hi"',
      '}',
      '',
    ].join('\n'),
  )

  const bPath = join(srcDir, 'b.ts')
  writeFileSync(
    bPath,
    [
      "import { oldName } from './a.js'",
      '',
      'export const greeting = oldName()',
      '',
    ].join('\n'),
  )

  return { tsconfigPath, aPath, bPath }
}

describe('createRenameSymbolTool', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rename-symbol-test-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('renames a function and updates cross-file references', async () => {
    const { tsconfigPath, aPath, bPath } = seedProject(tmpRoot)

    const tool = createRenameSymbolTool()
    const raw = await tool.invoke({
      tsconfigPath,
      filePath: aPath,
      symbolName: 'oldName',
      newName: 'newName',
    })

    // Tool returns JSON on success.
    const result = JSON.parse(raw) as {
      renamedCount: number
      affectedFiles: string[]
    }

    expect(result.renamedCount).toBeGreaterThan(0)
    expect(result.affectedFiles.length).toBeGreaterThanOrEqual(2)

    const aContent = readFileSync(aPath, 'utf8')
    const bContent = readFileSync(bPath, 'utf8')

    expect(aContent).toContain('newName')
    expect(aContent).not.toContain('oldName')
    expect(bContent).toContain('newName')
    expect(bContent).not.toContain('oldName')
  })

  it('throws (via the core impl) when the symbol does not exist', async () => {
    const { tsconfigPath, aPath } = seedProject(tmpRoot)

    await expect(
      renameSymbol({
        tsconfigPath,
        filePath: aPath,
        symbolName: 'doesNotExist',
        newName: 'whatever',
      }),
    ).rejects.toThrow(/symbol "doesNotExist" not found/)
  })

  it('tool wrapper surfaces unknown-symbol as a structured error string', async () => {
    const { tsconfigPath, aPath } = seedProject(tmpRoot)

    const tool = createRenameSymbolTool()
    const result = await tool.invoke({
      tsconfigPath,
      filePath: aPath,
      symbolName: 'doesNotExist',
      newName: 'whatever',
    })

    expect(result).toContain('rename_symbol failed')
    expect(result).toContain('doesNotExist')
  })

  // -------------------------------------------------------------------------
  // Cross-file rename (symbol used in multiple files)
  // -------------------------------------------------------------------------

  it('propagates a rename across multiple files that reference the symbol', async () => {
    const { tsconfigPath, aPath, bPath } = seedProject(tmpRoot)

    // Add a third file that also imports the same symbol.
    const cPath = join(tmpRoot, 'src', 'c.ts')
    writeFileSync(
      cPath,
      [
        "import { oldName } from './a.js'",
        '',
        'export const another = oldName()',
        '',
      ].join('\n'),
    )

    const raw = await renameSymbol({
      tsconfigPath,
      filePath: aPath,
      symbolName: 'oldName',
      newName: 'newName',
    })

    expect(raw.renamedCount).toBeGreaterThan(0)
    // At least a.ts, b.ts, c.ts were affected.
    expect(raw.affectedFiles.length).toBeGreaterThanOrEqual(3)

    // Read all three files and check the rename was propagated to every reference.
    expect(readFileSync(aPath, 'utf8')).toContain('newName')
    expect(readFileSync(aPath, 'utf8')).not.toContain('oldName')
    expect(readFileSync(bPath, 'utf8')).toContain('newName')
    expect(readFileSync(bPath, 'utf8')).not.toContain('oldName')
    expect(readFileSync(cPath, 'utf8')).toContain('newName')
    expect(readFileSync(cPath, 'utf8')).not.toContain('oldName')
  })

  // -------------------------------------------------------------------------
  // Rename updates import/export statements
  // -------------------------------------------------------------------------

  it('updates import and re-export statements that reference the symbol', async () => {
    const { tsconfigPath, aPath, bPath } = seedProject(tmpRoot)

    // File that re-exports the symbol.
    const reExportPath = join(tmpRoot, 'src', 'reexport.ts')
    writeFileSync(
      reExportPath,
      ["export { oldName } from './a.js'", ''].join('\n'),
    )

    await renameSymbol({
      tsconfigPath,
      filePath: aPath,
      symbolName: 'oldName',
      newName: 'brandNewName',
    })

    const importContent = readFileSync(bPath, 'utf8')
    const reExportContent = readFileSync(reExportPath, 'utf8')

    expect(importContent).toContain('import { brandNewName }')
    expect(importContent).not.toContain('oldName')
    expect(reExportContent).toContain('export { brandNewName }')
    expect(reExportContent).not.toContain('oldName')
  })

  // -------------------------------------------------------------------------
  // Graceful error when symbol not found (tool wrapper does not throw)
  // -------------------------------------------------------------------------

  it('tool wrapper returns an error string (does not throw) when symbol is missing', async () => {
    const { tsconfigPath, aPath } = seedProject(tmpRoot)

    const tool = createRenameSymbolTool()

    // Calling via .invoke should resolve, not reject, even on missing symbol.
    const result = await tool.invoke({
      tsconfigPath,
      filePath: aPath,
      symbolName: 'missingSymbolX',
      newName: 'whatever',
    })

    expect(typeof result).toBe('string')
    expect(result).toContain('rename_symbol failed')
    expect(result).toContain('missingSymbolX')

    // Source files are unchanged.
    const aContent = readFileSync(aPath, 'utf8')
    expect(aContent).toContain('oldName')
  })
})
