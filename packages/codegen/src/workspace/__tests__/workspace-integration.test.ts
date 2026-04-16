/**
 * Workspace integration test — verifies the full codegen agent workflow
 * using the workspace abstraction end-to-end with a real temp directory.
 *
 * Scenario: codegen agent uses workspace to write a file, search for content,
 * and run a command, then uses the WriteFileTool with workspace context.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { LocalWorkspace } from '../local-workspace.js'
import { WorkspaceFactory } from '../workspace-factory.js'
import type { WorkspaceOptions, Workspace } from '../types.js'
import type { CodegenToolContext } from '../../tools/tool-context.js'
import { createWriteFileTool } from '../../tools/write-file.tool.js'

describe('Workspace Integration', () => {
  let tempDir: string
  let workspace: Workspace

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `ws-integration-${randomUUID()}-`))
    const opts: WorkspaceOptions = {
      rootDir: tempDir,
      search: { provider: 'builtin' },
      command: {
        timeoutMs: 5_000,
        allowedCommands: ['echo', 'cat', 'ls', 'node'],
      },
    }
    workspace = WorkspaceFactory.create(opts)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('end-to-end: write, read, list, search, run command, and tool integration', async () => {
    // -----------------------------------------------------------------------
    // Step 1-2: WorkspaceFactory returns a LocalWorkspace; write a TS file
    // -----------------------------------------------------------------------
    expect(workspace).toBeInstanceOf(LocalWorkspace) // assertion 1
    await workspace.writeFile('src/hello.ts', 'export const greeting = "hello"')

    // -----------------------------------------------------------------------
    // Step 3: Verify the file exists
    // -----------------------------------------------------------------------
    const fileExists = await workspace.exists('src/hello.ts')
    expect(fileExists).toBe(true) // assertion 2

    // -----------------------------------------------------------------------
    // Step 4: Read it back and assert content matches
    // -----------------------------------------------------------------------
    const content = await workspace.readFile('src/hello.ts')
    expect(content).toBe('export const greeting = "hello"') // assertion 3

    // -----------------------------------------------------------------------
    // Step 5: List files with glob — src/hello.ts must appear
    // -----------------------------------------------------------------------
    const tsFiles = await workspace.listFiles('**/*.ts')
    expect(tsFiles).toContain('src/hello.ts') // assertion 4

    // -----------------------------------------------------------------------
    // Step 6: Search for 'greeting' — 1 result on the correct file/line
    // -----------------------------------------------------------------------
    const searchResults = await workspace.search('greeting')
    expect(searchResults.length).toBe(1) // assertion 5
    expect(searchResults[0]!.filePath).toBe('src/hello.ts') // assertion 6
    expect(searchResults[0]!.line).toBe(1) // assertion 7

    // -----------------------------------------------------------------------
    // Step 7: Run a command — echo returns expected stdout, exitCode 0
    // -----------------------------------------------------------------------
    const cmdResult = await workspace.runCommand('echo', ['workspace-test'])
    expect(cmdResult.exitCode).toBe(0) // assertion 8
    expect(cmdResult.stdout).toContain('workspace-test') // assertion 9
    expect(cmdResult.timedOut).toBe(false) // assertion 10

    // -----------------------------------------------------------------------
    // Step 8-9: Create CodegenToolContext + WriteFileTool backed by workspace
    // -----------------------------------------------------------------------
    const context: CodegenToolContext = { workspace }
    const writeFileTool = createWriteFileTool(context)

    // -----------------------------------------------------------------------
    // Step 10: Invoke the tool — file must appear on disk via workspace
    // -----------------------------------------------------------------------
    const toolOutput = await writeFileTool.invoke({
      filePath: 'src/utils/math.ts',
      content: 'export function add(a: number, b: number): number { return a + b }',
    })

    // Parse and validate the tool JSON response
    const parsed = JSON.parse(toolOutput as string) as {
      action: string
      filePath: string
      size: number
      success: boolean
    }
    expect(parsed.success).toBe(true) // assertion 11
    expect(parsed.filePath).toBe('src/utils/math.ts') // assertion 12

    // Verify the file was actually written to the filesystem through workspace
    const toolFileContent = await readFile(
      join(tempDir, 'src/utils/math.ts'),
      'utf-8',
    )
    expect(toolFileContent).toBe(
      'export function add(a: number, b: number): number { return a + b }',
    ) // assertion 13

    // Also verify via workspace.exists and workspace.readFile for consistency
    expect(await workspace.exists('src/utils/math.ts')).toBe(true) // assertion 14
    const wsRead = await workspace.readFile('src/utils/math.ts')
    expect(wsRead).toBe(toolFileContent) // assertion 15

    // Verify the new file also shows up in listFiles
    const allTsFiles = await workspace.listFiles('**/*.ts')
    expect(allTsFiles).toContain('src/utils/math.ts') // assertion 16
    expect(allTsFiles.length).toBe(2) // both hello.ts and math.ts
  })
})
