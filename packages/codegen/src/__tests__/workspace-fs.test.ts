import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { InMemoryWorkspaceFS, DiskWorkspaceFS } from '../vfs/workspace-fs.js'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// InMemoryWorkspaceFS
// ---------------------------------------------------------------------------

describe('InMemoryWorkspaceFS', () => {
  let vfs: VirtualFS
  let ws: InMemoryWorkspaceFS

  beforeEach(() => {
    vfs = new VirtualFS({ 'src/index.ts': 'export const a = 1' })
    ws = new InMemoryWorkspaceFS(vfs)
  })

  it('read returns file content', async () => {
    expect(await ws.read('src/index.ts')).toBe('export const a = 1')
  })

  it('read returns null for missing files', async () => {
    expect(await ws.read('missing.ts')).toBeNull()
  })

  it('write creates/overwrites files', async () => {
    await ws.write('src/new.ts', 'new content')
    expect(await ws.read('src/new.ts')).toBe('new content')

    await ws.write('src/new.ts', 'updated')
    expect(await ws.read('src/new.ts')).toBe('updated')
  })

  it('delete removes files', async () => {
    expect(await ws.delete('src/index.ts')).toBe(true)
    expect(await ws.read('src/index.ts')).toBeNull()
  })

  it('delete returns false for missing files', async () => {
    expect(await ws.delete('nope.ts')).toBe(false)
  })

  it('list returns all files', async () => {
    await ws.write('src/b.ts', 'b')
    const files = await ws.list()
    expect(files).toContain('src/index.ts')
    expect(files).toContain('src/b.ts')
  })

  it('list with prefix filters results', async () => {
    await ws.write('lib/util.ts', 'util')
    const srcFiles = await ws.list('src')
    expect(srcFiles).toContain('src/index.ts')
    expect(srcFiles).not.toContain('lib/util.ts')
  })

  it('snapshot returns all files as Record', async () => {
    await ws.write('src/b.ts', 'b')
    const snap = await ws.snapshot()
    expect(snap['src/index.ts']).toBe('export const a = 1')
    expect(snap['src/b.ts']).toBe('b')
  })

  it('applyPatch applies a unified diff', async () => {
    await ws.write('hello.txt', 'line1\nline2\nline3\n')

    const patch = [
      '--- a/hello.txt',
      '+++ b/hello.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2_modified',
      ' line3',
    ].join('\n')

    const result = await ws.applyPatch(patch)
    expect(result.rolledBack).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.success).toBe(true)

    const content = await ws.read('hello.txt')
    expect(content).toContain('line2_modified')
  })
})

// ---------------------------------------------------------------------------
// DiskWorkspaceFS
// ---------------------------------------------------------------------------

describe('DiskWorkspaceFS', () => {
  let tmpRoot: string
  let ws: DiskWorkspaceFS

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'ws-test-'))
    ws = new DiskWorkspaceFS(tmpRoot)

    // Seed a file
    await mkdir(join(tmpRoot, 'src'), { recursive: true })
    await writeFile(join(tmpRoot, 'src/main.ts'), 'const x = 1', 'utf-8')
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('read returns file content from disk', async () => {
    expect(await ws.read('src/main.ts')).toBe('const x = 1')
  })

  it('read returns null for missing files', async () => {
    expect(await ws.read('nope.ts')).toBeNull()
  })

  it('write creates files on disk', async () => {
    await ws.write('src/new.ts', 'new content')
    const content = await readFile(join(tmpRoot, 'src/new.ts'), 'utf-8')
    expect(content).toBe('new content')
  })

  it('write creates nested directories', async () => {
    await ws.write('deep/nested/file.ts', 'deep')
    const content = await readFile(join(tmpRoot, 'deep/nested/file.ts'), 'utf-8')
    expect(content).toBe('deep')
  })

  it('delete removes files from disk', async () => {
    expect(await ws.delete('src/main.ts')).toBe(true)
    expect(await ws.read('src/main.ts')).toBeNull()
  })

  it('delete returns false for missing files', async () => {
    expect(await ws.delete('nope.ts')).toBe(false)
  })

  it('list returns relative paths', async () => {
    await ws.write('src/b.ts', 'b')
    const files = await ws.list()
    expect(files).toContain('src/main.ts')
    expect(files).toContain('src/b.ts')
  })

  it('snapshot returns all files', async () => {
    const snap = await ws.snapshot()
    expect(snap['src/main.ts']).toBe('const x = 1')
  })

  it('rejects path traversal', async () => {
    await expect(ws.read('../../etc/passwd')).resolves.toBeNull()
    // write should throw
    await expect(ws.write('../../etc/evil', 'bad')).rejects.toThrow('Path traversal')
  })

  it('applyPatch applies a unified diff to disk files', async () => {
    const patch = [
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -1 +1 @@',
      '-const x = 1',
      '+const x = 2',
    ].join('\n')

    const result = await ws.applyPatch(patch)
    expect(result.results[0]!.success).toBe(true)

    const content = await readFile(join(tmpRoot, 'src/main.ts'), 'utf-8')
    expect(content).toBe('const x = 2')
  })
})

// Need afterEach in describe scope — add import
import { afterEach } from 'vitest'
