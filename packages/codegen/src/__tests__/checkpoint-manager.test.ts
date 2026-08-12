import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointManager } from '../vfs/checkpoint-manager.js'

const execFileAsync = promisify(execFile)

function expectCreated(result: Awaited<ReturnType<CheckpointManager['ensureCheckpoint']>>): string {
  expect(result.status).toBe('created')
  if (result.status !== 'created') throw new Error('expected a created checkpoint')
  return result.checkpointId
}

describe('CheckpointManager real-Git qualification', () => {
  let tempRoot: string
  let workDir: string
  let baseDir: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dzup-checkpoint-test-'))
    workDir = join(tempRoot, 'work')
    baseDir = join(tempRoot, 'checkpoints')
    await mkdir(workDir)
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('retains an executable expected-red proof for the rejected legacy --exclude command', async () => {
    const shadowDir = join(tempRoot, 'legacy-shadow')
    await writeFile(join(workDir, 'file.txt'), 'proof')
    const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: workDir }
    await execFileAsync('git', ['init', '--quiet'], { cwd: workDir, env })

    let exitCode: unknown = null
    try {
      await execFileAsync('git', ['add', '-A', '--exclude', 'node_modules'], {
        cwd: workDir,
        env,
      })
    } catch (error: unknown) {
      exitCode = (error as { code?: unknown }).code
    }
    expect(exitCode).toBe(129)
  })

  it('creates, deduplicates per turn, snapshots changes, and reopens the store', async () => {
    await writeFile(join(workDir, 'file.txt'), 'one')
    const manager = new CheckpointManager({ baseDir })

    const firstId = expectCreated(await manager.ensureCheckpoint(workDir, 'first | snapshot'))
    expect(await manager.ensureCheckpoint(workDir, 'same turn')).toEqual({
      status: 'deduplicated',
      checkpointId: firstId,
    })

    manager.newTurn()
    expect(await manager.ensureCheckpoint(workDir, 'unchanged')).toEqual({
      status: 'deduplicated',
      checkpointId: firstId,
    })

    await writeFile(join(workDir, 'file.txt'), 'two')
    manager.newTurn()
    const secondId = expectCreated(await manager.ensureCheckpoint(workDir, 'second snapshot'))
    expect(secondId).not.toBe(firstId)

    const reopened = new CheckpointManager({ baseDir })
    const reopenedResult = await reopened.ensureCheckpoint(workDir, 'restart retry')
    expect(reopenedResult).toEqual({ status: 'deduplicated', checkpointId: secondId })

    const listed = await reopened.listDetailed(workDir)
    expect(listed.status).toBe('ok')
    if (listed.status !== 'ok') return
    expect(listed.checkpoints.map((entry) => entry.hash)).toEqual([secondId, firstId])
    expect(listed.checkpoints[1]!.reason).toBe('first | snapshot')
  })

  it('snapshots an empty unborn Git worktree without importing its repository state', async () => {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workDir })
    const manager = new CheckpointManager({ baseDir })
    const checkpointId = expectCreated(await manager.ensureCheckpoint(workDir, 'empty root'))
    manager.newTurn()
    expect(await manager.ensureCheckpoint(workDir, 'empty retry')).toEqual({
      status: 'deduplicated',
      checkpointId,
    })
  })

  it('does not convert a failed first snapshot into a successful deduplication', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    await writeFile(baseDir, 'blocks directory creation')
    const manager = new CheckpointManager({ baseDir })

    const failed = await manager.ensureCheckpoint(workDir, 'first attempt')
    expect(failed.status).toBe('failed')
    if (failed.status === 'failed') expect(failed.code).toBe('io_failure')

    await rm(baseDir)
    await mkdir(baseDir)
    expectCreated(await manager.ensureCheckpoint(workDir, 'retry'))
  })

  it('serializes concurrent initialization across manager instances', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    const first = new CheckpointManager({ baseDir })
    const second = new CheckpointManager({ baseDir })

    const results = await Promise.all([
      first.ensureCheckpoint(workDir, 'first'),
      second.ensureCheckpoint(workDir, 'second'),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['created', 'deduplicated'])
    expect(await first.list(workDir)).toHaveLength(1)
  })

  it('allows independent roots to initialize concurrently', async () => {
    const secondRoot = join(tempRoot, 'second-root')
    await mkdir(secondRoot)
    await writeFile(join(workDir, 'first.txt'), 'first')
    await writeFile(join(secondRoot, 'second.txt'), 'second')
    const manager = new CheckpointManager({ baseDir })

    const results = await Promise.all([
      manager.ensureCheckpoint(workDir, 'first root'),
      manager.ensureCheckpoint(secondRoot, 'second root'),
    ])
    expect(results).toHaveLength(2)
    expect(results.filter((result) => result.status === 'created')).toHaveLength(2)
  })

  it('binds symlink aliases to one canonical root and full identity', async () => {
    const alias = join(tempRoot, 'work-alias')
    await symlink(workDir, alias, 'dir')
    await writeFile(join(workDir, 'file.txt'), 'content')
    const first = new CheckpointManager({ baseDir })
    const second = new CheckpointManager({ baseDir })

    const firstResult = await first.ensureCheckpoint(alias, 'via alias')
    const secondResult = await second.ensureCheckpoint(workDir, 'via canonical root')
    expect(firstResult.status).toBe('created')
    expect(secondResult.status).toBe('deduplicated')
    if (firstResult.status === 'created' && secondResult.status === 'deduplicated') {
      expect(secondResult.checkpointId).toBe(firstResult.checkpointId)
    }
  })

  it('fails closed when the persisted root identity does not match', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    const canonicalRoot = await realpath(workDir)
    const digest = createHash('sha256').update(canonicalRoot).digest('hex')
    const storeDir = join(baseDir, digest)
    await mkdir(storeDir, { recursive: true })
    await writeFile(join(storeDir, 'root-identity.v1.json'), JSON.stringify({
      version: 1,
      policyVersion: 1,
      canonicalRoot: join(tempRoot, 'wrong-root'),
      rootSha256: digest,
    }))

    const result = await new CheckpointManager({ baseDir }).ensureCheckpoint(workDir, 'mismatch')
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.code).toBe('corrupt_store')
  })

  it('classifies a structurally corrupt shadow repository without exposing paths', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    const manager = new CheckpointManager({ baseDir })
    expectCreated(await manager.ensureCheckpoint(workDir, 'baseline'))
    const canonicalRoot = await realpath(workDir)
    const digest = createHash('sha256').update(canonicalRoot).digest('hex')
    const objectsDir = join(baseDir, digest, 'repo', 'objects')
    await rename(objectsDir, `${objectsDir}.bak`)
    await writeFile(objectsDir, 'corrupt')

    const listed = await manager.listDetailed(workDir)
    expect(listed.status).toBe('failed')
    if (listed.status !== 'failed') return
    expect(listed.code).toBe('corrupt_store')
    expect(listed.error).not.toContain(tempRoot)
  })

  it('rejects broad roots and invalid numeric configuration', async () => {
    const unsafe = await new CheckpointManager({ baseDir }).ensureCheckpoint('/', 'unsafe')
    expect(unsafe).toEqual({
      status: 'skipped',
      code: 'unsafe_input',
      reason: 'checkpoint root is too broad',
    })
    expect(() => new CheckpointManager({ baseDir, maxFiles: 0 })).toThrow(/maxFiles/)
    expect(() => new CheckpointManager({ baseDir, timeoutMs: Number.NaN })).toThrow(/timeoutMs/)
  })

  it('enforces recursive count, byte, depth, and path ceilings before store creation', async () => {
    const countRoot = join(tempRoot, 'count-root')
    await mkdir(join(countRoot, 'nested'), { recursive: true })
    await writeFile(join(countRoot, 'one.txt'), '1')
    await writeFile(join(countRoot, 'nested', 'two.txt'), '2')
    const countResult = await new CheckpointManager({ baseDir, maxFiles: 1 })
      .ensureCheckpoint(countRoot, 'count')
    expect(countResult.status).toBe('skipped')
    if (countResult.status === 'skipped') expect(countResult.code).toBe('resource_limit')

    const byteRoot = join(tempRoot, 'byte-root')
    await mkdir(byteRoot)
    await writeFile(join(byteRoot, 'large.txt'), '12345')
    const byteResult = await new CheckpointManager({ baseDir, maxFileBytes: 4 })
      .ensureCheckpoint(byteRoot, 'bytes')
    expect(byteResult.status).toBe('skipped')

    const depthRoot = join(tempRoot, 'depth-root')
    await mkdir(join(depthRoot, 'one', 'two'), { recursive: true })
    await writeFile(join(depthRoot, 'one', 'two', 'file.txt'), 'deep')
    const depthResult = await new CheckpointManager({ baseDir, maxDepth: 2 })
      .ensureCheckpoint(depthRoot, 'depth')
    expect(depthResult.status).toBe('skipped')

    const pathRoot = join(tempRoot, 'path-root')
    await mkdir(pathRoot)
    await writeFile(join(pathRoot, 'long-name.txt'), 'path')
    const pathResult = await new CheckpointManager({ baseDir, maxPathBytes: 4 })
      .ensureCheckpoint(pathRoot, 'path')
    expect(pathResult.status).toBe('skipped')

    await expect(lstat(baseDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsupported filesystem entry types before Git object creation', async () => {
    await execFileAsync('mkfifo', [join(workDir, 'named-pipe')])
    const result = await new CheckpointManager({ baseDir }).ensureCheckpoint(workDir, 'fifo')
    expect(result.status).toBe('skipped')
    if (result.status === 'skipped') expect(result.code).toBe('unsafe_input')
    await expect(lstat(baseDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses real Git pathspec exclusions and includes ignored admitted files', async () => {
    await mkdir(join(workDir, 'nested'), { recursive: true })
    await mkdir(join(workDir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(workDir, 'dist'), { recursive: true })
    await writeFile(join(workDir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(workDir, 'public.txt'), 'one')
    await writeFile(join(workDir, 'ignored.txt'), 'one')
    await writeFile(join(workDir, '.env'), 'secret-one')
    await writeFile(join(workDir, 'nested', '.env.local'), 'secret-two')
    await writeFile(join(workDir, 'nested', 'secrets.json'), 'secret-three')
    await writeFile(join(workDir, 'node_modules', 'pkg', 'index.js'), 'generated-one')
    await writeFile(join(workDir, 'dist', 'bundle.js'), 'generated-two')

    const manager = new CheckpointManager({ baseDir })
    const checkpointId = expectCreated(await manager.ensureCheckpoint(workDir, 'baseline'))
    await writeFile(join(workDir, 'public.txt'), 'two')
    await writeFile(join(workDir, 'ignored.txt'), 'two')
    await writeFile(join(workDir, '.env'), 'secret-four')
    await writeFile(join(workDir, 'nested', '.env.local'), 'secret-five')
    await writeFile(join(workDir, 'node_modules', 'pkg', 'index.js'), 'generated-three')

    const result = await manager.diffDetailed(workDir, checkpointId)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.diff.modified.sort()).toEqual(['ignored.txt', 'public.txt'])
    expect(result.diff.added).toEqual([])
    expect(result.diff.deleted).toEqual([])
  })

  it('removes inherited Git control variables at the process boundary', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    const hostileObjects = join(tempRoot, 'hostile-objects')
    await mkdir(hostileObjects)
    const previousObjectDirectory = process.env['GIT_OBJECT_DIRECTORY']
    process.env['GIT_OBJECT_DIRECTORY'] = hostileObjects
    try {
      expectCreated(await new CheckpointManager({ baseDir }).ensureCheckpoint(workDir, 'isolated env'))
    } finally {
      if (previousObjectDirectory === undefined) delete process.env['GIT_OBJECT_DIRECTORY']
      else process.env['GIT_OBJECT_DIRECTORY'] = previousObjectDirectory
    }
    expect(await readdir(hostileObjects)).toEqual([])
  })

  it('preserves nested repositories outside the admitted checkpoint tree', async () => {
    const nestedRepo = join(workDir, 'vendor', 'nested-repo')
    await mkdir(nestedRepo, { recursive: true })
    await execFileAsync('git', ['init', '--quiet'], { cwd: nestedRepo })
    await writeFile(join(nestedRepo, 'nested.txt'), 'one')
    await writeFile(join(workDir, 'public.txt'), 'one')
    const manager = new CheckpointManager({ baseDir })
    const checkpointId = expectCreated(await manager.ensureCheckpoint(workDir, 'baseline'))

    await writeFile(join(nestedRepo, 'nested.txt'), 'two')
    await writeFile(join(workDir, 'public.txt'), 'two')
    const result = await manager.diffDetailed(workDir, checkpointId)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.diff.modified).toEqual(['public.txt'])
  })

  it('diffs staged current-tree additions, edits, and deletions', async () => {
    await writeFile(join(workDir, 'edit.txt'), 'before\n')
    await writeFile(join(workDir, 'delete.txt'), 'delete me\n')
    const manager = new CheckpointManager({ baseDir })
    const checkpointId = expectCreated(await manager.ensureCheckpoint(workDir, 'baseline'))

    await writeFile(join(workDir, 'edit.txt'), 'after\nextra\n')
    await rm(join(workDir, 'delete.txt'))
    await writeFile(join(workDir, 'add.txt'), 'new\n')
    const result = await manager.diffDetailed(workDir, checkpointId)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.diff.added).toEqual(['add.txt'])
    expect(result.diff.modified).toEqual(['edit.txt'])
    expect(result.diff.deleted).toEqual(['delete.txt'])
    expect(result.diff.stats.filesChanged).toBe(3)
    expect(result.diff.stats.insertions).toBeGreaterThan(0)
    expect(result.diff.stats.deletions).toBeGreaterThan(0)
  })

  it('restores exact admitted create/edit/delete, symlink, and executable-mode state', async () => {
    const executable = join(workDir, 'run.sh')
    await writeFile(join(workDir, 'target.txt'), 'target\n')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    await symlink('target.txt', join(workDir, 'link.txt'))
    await writeFile(join(workDir, '.env'), 'preserve-one')

    const manager = new CheckpointManager({ baseDir })
    const checkpointId = expectCreated(await manager.ensureCheckpoint(workDir, 'target'))
    await writeFile(join(workDir, 'target.txt'), 'changed\n')
    await chmod(executable, 0o644)
    await rm(join(workDir, 'link.txt'))
    await writeFile(join(workDir, 'created-after.txt'), 'remove me')
    await writeFile(join(workDir, '.env'), 'preserve-two')

    const restored = await manager.restoreDetailed(workDir, checkpointId)
    expect(restored.status).toBe('restored')
    expect(await readFile(join(workDir, 'target.txt'), 'utf8')).toBe('target\n')
    // Git records the executable bit, while the process umask controls the
    // remaining write bits when the worktree entry is recreated.
    expect((await lstat(executable)).mode & 0o111).toBe(0o111)
    expect(await readlink(join(workDir, 'link.txt'))).toBe('target.txt')
    await expect(lstat(join(workDir, 'created-after.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(workDir, '.env'), 'utf8')).toBe('preserve-two')
  })

  it('requires the safety snapshot to succeed before restore mutation', async () => {
    await writeFile(join(workDir, 'target.txt'), 'target')
    const manager = new CheckpointManager({ baseDir })
    const checkpointId = expectCreated(await manager.ensureCheckpoint(workDir, 'target'))
    await writeFile(join(workDir, 'target.txt'), 'changed')

    await execFileAsync('mkfifo', [join(workDir, 'unsafe-entry')])

    const result = await manager.restoreDetailed(workDir, checkpointId)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.code).toBe('unsafe_input')
    expect(await readFile(join(workDir, 'target.txt'), 'utf8')).toBe('changed')
  })

  it('distinguishes invalid and missing checkpoint identities', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    const manager = new CheckpointManager({ baseDir })

    const invalid = await manager.restoreDetailed(workDir, 'HEAD')
    expect(invalid.status).toBe('failed')
    if (invalid.status === 'failed') expect(invalid.code).toBe('unsafe_input')

    const missing = await manager.restoreDetailed(workDir, '0'.repeat(40))
    expect(missing.status).toBe('failed')
    if (missing.status === 'failed') expect(missing.code).toBe('not_found')
  })

  it('prunes explicit checkpoint refs and proves removed commits are unreachable', async () => {
    const manager = new CheckpointManager({ baseDir, maxSnapshots: 2 })
    await writeFile(join(workDir, 'file.txt'), 'one')
    const firstId = expectCreated(await manager.ensureCheckpoint(workDir, 'one'))
    manager.newTurn()
    await writeFile(join(workDir, 'file.txt'), 'two')
    expectCreated(await manager.ensureCheckpoint(workDir, 'two'))
    manager.newTurn()
    await writeFile(join(workDir, 'file.txt'), 'three')
    expectCreated(await manager.ensureCheckpoint(workDir, 'three'))

    const entries = await manager.list(workDir)
    expect(entries).toHaveLength(2)
    expect(entries.some((entry) => entry.hash === firstId)).toBe(false)

    const canonicalRoot = await realpath(workDir)
    const digest = createHash('sha256').update(canonicalRoot).digest('hex')
    const gitDir = join(baseDir, digest, 'repo')
    const { stdout: reachable } = await execFileAsync('git', ['rev-list', '--all', '--reflog'], {
      cwd: workDir,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workDir },
    })
    expect(reachable.split('\n')).not.toContain(firstId)
  })

  it('supports roots containing spaces and Unicode', async () => {
    const unicodeRoot = join(tempRoot, 'root with spaces ž')
    await mkdir(unicodeRoot)
    await writeFile(join(unicodeRoot, 'hello world.txt'), 'hello')
    const result = await new CheckpointManager({ baseDir })
      .ensureCheckpoint(unicodeRoot, 'unicode root')
    expect(result.status).toBe('created')
  })

  it('keeps failure diagnostics bounded and free of workspace paths', async () => {
    await writeFile(join(workDir, 'file.txt'), 'content')
    await writeFile(baseDir, 'not a directory')
    const result = await new CheckpointManager({ baseDir }).ensureCheckpoint(workDir, 'failure')
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.error.length).toBeLessThan(200)
    expect(result.error).not.toContain(tempRoot)
    expect(result.error).not.toContain(workDir)
    expect(result.error).not.toContain(baseDir)
  })
})
