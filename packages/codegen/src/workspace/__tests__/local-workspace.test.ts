import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { LocalWorkspace } from '../local-workspace.js'
import type { WorkspaceOptions } from '../types.js'

describe('LocalWorkspace', () => {
  let tempDir: string
  let ws: LocalWorkspace

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `lw-test-${randomUUID()}-`))
    const opts: WorkspaceOptions = {
      rootDir: tempDir,
      search: { provider: 'builtin' },
      command: {
        timeoutMs: 5_000,
        allowedCommands: ['echo', 'cat', 'ls', 'node'],
      },
    }
    ws = new LocalWorkspace(opts)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // ---- readFile -----------------------------------------------------------

  it('readFile returns file contents', async () => {
    await writeFile(join(tempDir, 'hello.txt'), 'hello world', 'utf-8')
    const content = await ws.readFile('hello.txt')
    expect(content).toBe('hello world')
  })

  it('readFile throws for missing file', async () => {
    await expect(ws.readFile('does-not-exist.txt')).rejects.toThrow()
  })

  // ---- writeFile ----------------------------------------------------------

  it('writeFile creates a new file', async () => {
    await ws.writeFile('output.txt', 'created')
    const content = await readFile(join(tempDir, 'output.txt'), 'utf-8')
    expect(content).toBe('created')
  })

  it('writeFile creates parent directories as needed', async () => {
    await ws.writeFile('deep/nested/dir/file.ts', 'export const x = 1')
    const content = await readFile(join(tempDir, 'deep/nested/dir/file.ts'), 'utf-8')
    expect(content).toBe('export const x = 1')
  })

  // ---- listFiles ----------------------------------------------------------

  it('listFiles matches *.ts glob at root', async () => {
    await ws.writeFile('index.ts', 'export {}')
    await ws.writeFile('readme.md', '# Hi')
    const files = await ws.listFiles('*.ts')
    expect(files).toContain('index.ts')
    expect(files).not.toContain('readme.md')
  })

  it('listFiles matches **/*.ts recursively', async () => {
    await ws.writeFile('src/a.ts', 'a')
    await ws.writeFile('src/lib/b.ts', 'b')
    await ws.writeFile('src/lib/c.js', 'c')
    const files = await ws.listFiles('**/*.ts')
    expect(files).toContain('src/a.ts')
    expect(files).toContain('src/lib/b.ts')
    expect(files).not.toContain('src/lib/c.js')
  })

  // ---- search (builtin) ---------------------------------------------------

  it('search finds text matches across files', async () => {
    await ws.writeFile('a.ts', 'const foo = 1\nconst bar = 2')
    await ws.writeFile('b.ts', 'const baz = 3')
    const results = await ws.search('const bar')
    expect(results.length).toBe(1)
    expect(results[0]!.matchText).toBe('const bar')
    expect(results[0]!.line).toBe(2)
  })

  // ---- runCommand ---------------------------------------------------------

  it('runCommand captures stdout', async () => {
    const result = await ws.runCommand('echo', ['hello'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('runCommand captures stderr and non-zero exit code', async () => {
    const result = await ws.runCommand('node', ['-e', 'process.stderr.write("oops"); process.exit(2)'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('oops')
  })

  it('runCommand blocks disallowed commands with exitCode 126', async () => {
    const result = await ws.runCommand('rm', ['-rf', '/'])
    expect(result.exitCode).toBe(126)
    expect(result.stderr).toContain('not in the allowed commands list')
  })

  // ---- exists -------------------------------------------------------------

  it('exists returns true for an existing file', async () => {
    await ws.writeFile('present.txt', 'yes')
    expect(await ws.exists('present.txt')).toBe(true)
  })

  it('exists returns false for a missing path', async () => {
    expect(await ws.exists('ghost.txt')).toBe(false)
  })
})
