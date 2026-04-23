import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryWorkspaceFS, VirtualFS } from '@dzupagent/codegen'
import {
  FileRollbackStore,
  InMemoryRollbackStore,
  DEFAULT_ROLLBACK_STORAGE_DIR,
  type RollbackEntry,
} from '../rollback/file-rollback-store.js'
import {
  createApplyPatchTool,
  undoApplyPatch,
  __clearRollbackRegistry,
  __getDefaultRollbackStore,
} from '../tools/apply-patch.tool.js'

function makeWorkspace(
  seed: Record<string, string> = {},
): InMemoryWorkspaceFS {
  const vfs = new VirtualFS()
  for (const [p, content] of Object.entries(seed)) {
    vfs.write(p, content)
  }
  return new InMemoryWorkspaceFS(vfs)
}

const VALID_DIFF = [
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+line2_modified',
  ' line3',
  '',
].join('\n')

const INITIAL_FILE = ['line1', 'line2', 'line3', ''].join('\n')

function extractRollbackToken(result: string): string | null {
  const m = result.match(/rollbackToken:\s*([a-zA-Z0-9-]+)/)
  return m?.[1] ?? null
}

describe('InMemoryRollbackStore', () => {
  it('saves, loads, lists, and deletes entries', async () => {
    const store = new InMemoryRollbackStore()
    const ws = makeWorkspace()
    const entry: RollbackEntry = {
      workspace: ws,
      originals: new Map([['src/a.ts', 'hello']]),
    }

    await store.save('tok-1', entry)
    expect(await store.list()).toEqual(['tok-1'])

    const loaded = await store.load('tok-1')
    expect(loaded?.originals.get('src/a.ts')).toBe('hello')
    expect(loaded?.workspace).toBe(ws)

    await store.delete('tok-1')
    expect(await store.load('tok-1')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })
})

describe('FileRollbackStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rollback-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('save + load round-trips an entry', async () => {
    const ws = makeWorkspace()
    const store = new FileRollbackStore(ws, { storageDir: dir })
    const entry: RollbackEntry = {
      workspace: ws,
      originals: new Map([
        ['src/a.ts', 'original-a'],
        ['src/b.ts', null],
      ]),
    }

    await store.save('tok-42', entry)
    expect(existsSync(join(dir, 'tok-42.json'))).toBe(true)

    const loaded = await store.load('tok-42')
    expect(loaded).toBeDefined()
    expect(loaded?.workspace).toBe(ws)
    expect(loaded?.originals.get('src/a.ts')).toBe('original-a')
    expect(loaded?.originals.get('src/b.ts')).toBeNull()
  })

  it('load returns undefined for missing token', async () => {
    const ws = makeWorkspace()
    const store = new FileRollbackStore(ws, { storageDir: dir })
    expect(await store.load('nope')).toBeUndefined()
  })

  it('delete removes the file', async () => {
    const ws = makeWorkspace()
    const store = new FileRollbackStore(ws, { storageDir: dir })
    await store.save('tok', {
      workspace: ws,
      originals: new Map([['x.ts', 'v']]),
    })
    expect(existsSync(join(dir, 'tok.json'))).toBe(true)

    await store.delete('tok')
    expect(existsSync(join(dir, 'tok.json'))).toBe(false)

    // Deleting an absent token is a no-op.
    await expect(store.delete('tok')).resolves.toBeUndefined()
  })

  it('list returns every persisted token (no .json suffix)', async () => {
    const ws = makeWorkspace()
    const store = new FileRollbackStore(ws, { storageDir: dir })
    await store.save('tok-a', {
      workspace: ws,
      originals: new Map(),
    })
    await store.save('tok-b', {
      workspace: ws,
      originals: new Map(),
    })
    const tokens = await store.list()
    expect(tokens.sort()).toEqual(['tok-a', 'tok-b'])
  })

  it('list returns [] when storage dir does not exist yet', async () => {
    const ws = makeWorkspace()
    const store = new FileRollbackStore(ws, {
      storageDir: join(dir, 'does-not-exist-yet'),
    })
    expect(await store.list()).toEqual([])
  })

  it('storageDir defaults to .dzupagent/rollbacks', () => {
    const ws = makeWorkspace()
    const store = new FileRollbackStore(ws)
    // storageDir is private -- reach into it via a guarded cast.
    const internal = store as unknown as { storageDir: string }
    expect(internal.storageDir).toBe(DEFAULT_ROLLBACK_STORAGE_DIR)
  })

  it('survives process restart (write then re-instantiate and load)', async () => {
    const ws = makeWorkspace()
    const writer = new FileRollbackStore(ws, { storageDir: dir })
    await writer.save('persisted', {
      workspace: ws,
      originals: new Map([['src/index.ts', INITIAL_FILE]]),
    })

    // Verify the file was actually written to disk (simulate restart by
    // discarding the writer and reading raw JSON).
    const raw = await readFile(join(dir, 'persisted.json'), 'utf-8')
    const parsed = JSON.parse(raw) as {
      originals: Array<[string, string | null]>
    }
    expect(parsed.originals).toEqual([['src/index.ts', INITIAL_FILE]])

    // New instance, new workspace -- simulates a cold process bound to a
    // freshly constructed workspace for the same project.
    const freshWs = makeWorkspace({ 'src/index.ts': 'modified' })
    const reader = new FileRollbackStore(freshWs, { storageDir: dir })
    const entry = await reader.load('persisted')
    expect(entry).toBeDefined()
    expect(entry?.workspace).toBe(freshWs)
    expect(entry?.originals.get('src/index.ts')).toBe(INITIAL_FILE)
  })
})

describe('createApplyPatchTool store wiring', () => {
  beforeEach(() => {
    __clearRollbackRegistry()
  })

  it('uses InMemoryRollbackStore by default', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const tool = createApplyPatchTool(ws)
    const result = await tool.invoke({ diff: VALID_DIFF })
    const token = extractRollbackToken(String(result))
    expect(token).toBeTruthy()

    // Default store must be the in-memory variant; token should be present.
    const store = __getDefaultRollbackStore()
    expect(store).toBeInstanceOf(InMemoryRollbackStore)
    expect(await store.list()).toContain(token!)

    // undoApplyPatch round-trips through the default store.
    expect(await undoApplyPatch(token!)).toBe(true)
    expect(await store.list()).not.toContain(token!)
  })

  it('wires FileRollbackStore when storageDir is provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-patch-file-store-'))
    try {
      const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
      const tool = createApplyPatchTool(ws, { storageDir: dir })
      const result = await tool.invoke({ diff: VALID_DIFF })
      const token = extractRollbackToken(String(result))
      expect(token).toBeTruthy()

      // Entry must be on disk, not in the in-memory default.
      expect(existsSync(join(dir, `${token!}.json`))).toBe(true)
      const defaultStore = __getDefaultRollbackStore()
      expect(await defaultStore.list()).not.toContain(token!)

      // Rehydrate from disk and assert originals were captured.
      const fileStore = new FileRollbackStore(ws, { storageDir: dir })
      const entry = await fileStore.load(token!)
      expect(entry?.originals.get('src/index.ts')).toBe(INITIAL_FILE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honours an explicit rollbackStore option over storageDir', async () => {
    const custom = new InMemoryRollbackStore()
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const tool = createApplyPatchTool(ws, {
      rollbackStore: custom,
      storageDir: '/tmp/should-be-ignored',
    })
    const result = await tool.invoke({ diff: VALID_DIFF })
    const token = extractRollbackToken(String(result))
    expect(token).toBeTruthy()
    expect(await custom.list()).toContain(token!)
  })
})
