import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderContextGenerator } from '../folder-context-generator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'folder-ctx-'))
}

async function writeFileAt(root: string, rel: string, content = 'x'): Promise<string> {
  const full = join(root, rel)
  const dir = full.slice(0, full.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(full, content, 'utf8')
  return full
}

async function setMtime(full: string, date: Date): Promise<void> {
  await utimes(full, date, date)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FolderContextGenerator', () => {
  let root: string

  beforeEach(async () => {
    root = await makeTmpDir()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('walks directory up to maxDepth', async () => {
    await writeFileAt(root, 'a.ts')
    await writeFileAt(root, 'sub/b.ts')
    await writeFileAt(root, 'sub/deeper/c.ts')

    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 3 })
    const files = await gen.scoreFiles()
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['a.ts', 'sub/b.ts', 'sub/deeper/c.ts'])
  })

  it('does not exceed maxDepth', async () => {
    await writeFileAt(root, 'a.ts') // depth 0
    await writeFileAt(root, 'sub/b.ts') // depth 1
    await writeFileAt(root, 'sub/deeper/c.ts') // depth 2
    await writeFileAt(root, 'sub/deeper/toomuch/d.ts') // depth 3

    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 1 })
    const files = await gen.scoreFiles()
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['a.ts', 'sub/b.ts'])
  })

  it('filters by extension', async () => {
    await writeFileAt(root, 'keep.ts')
    await writeFileAt(root, 'drop.txt')
    await writeFileAt(root, 'keep.md')

    const gen = new FolderContextGenerator({
      rootDir: root,
      extensions: ['.ts', '.md'],
    })
    const files = await gen.scoreFiles()
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['keep.md', 'keep.ts'])
  })

  it('scores .ts files higher than .txt by extension dimension', async () => {
    // Use .txt via explicit extensions so both are scanned
    await writeFileAt(root, 'a.ts')
    await writeFileAt(root, 'b.txt')

    const gen = new FolderContextGenerator({
      rootDir: root,
      extensions: ['.ts', '.txt'],
    })
    const files = await gen.scoreFiles()
    const ts = files.find((f) => f.path === 'a.ts')!
    const txt = files.find((f) => f.path === 'b.txt')!
    expect(ts.score).toBeGreaterThan(txt.score)
  })

  it('scores recently modified files higher than old ones', async () => {
    const fresh = await writeFileAt(root, 'fresh.ts')
    const old = await writeFileAt(root, 'old.ts')

    const now = new Date()
    await setMtime(fresh, now)
    // 30 days ago
    await setMtime(old, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))

    const gen = new FolderContextGenerator({ rootDir: root })
    const files = await gen.scoreFiles()
    const freshScore = files.find((f) => f.path === 'fresh.ts')!.score
    const oldScore = files.find((f) => f.path === 'old.ts')!.score
    expect(freshScore).toBeGreaterThan(oldScore)
  })

  it('scores shallower files higher than deeper files (all else equal)', async () => {
    await writeFileAt(root, 'shallow.ts')
    await writeFileAt(root, 'a/b/deep.ts')

    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 4 })
    const files = await gen.scoreFiles()
    const shallow = files.find((f) => f.path === 'shallow.ts')!
    const deep = files.find((f) => f.path === 'a/b/deep.ts')!
    expect(shallow.score).toBeGreaterThan(deep.score)
  })

  it('scores index.ts highest by name among siblings', async () => {
    await writeFileAt(root, 'index.ts')
    await writeFileAt(root, 'helper.ts')
    await writeFileAt(root, 'utils.test.ts')

    const gen = new FolderContextGenerator({ rootDir: root })
    const files = await gen.scoreFiles()
    const index = files.find((f) => f.path === 'index.ts')!
    const helper = files.find((f) => f.path === 'helper.ts')!
    const test = files.find((f) => f.path === 'utils.test.ts')!
    expect(index.score).toBeGreaterThan(helper.score)
    expect(index.score).toBeGreaterThan(test.score)
  })

  it('returns cached result on second call within TTL', async () => {
    await writeFileAt(root, 'a.ts')
    const gen = new FolderContextGenerator({ rootDir: root, cacheTtlMs: 60_000 })

    const first = await gen.generate()
    // Add a file AFTER first generate — cache should mask it
    await writeFileAt(root, 'b.ts')
    const second = await gen.generate()

    expect(second).toBe(first)
    expect(second.files.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('regenerates after TTL expires', async () => {
    await writeFileAt(root, 'a.ts')
    const gen = new FolderContextGenerator({ rootDir: root, cacheTtlMs: 1 })

    const first = await gen.generate()
    expect(first.files).toHaveLength(1)

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFileAt(root, 'b.ts')

    const second = await gen.generate()
    expect(second).not.toBe(first)
    expect(second.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('invalidateCache() forces regeneration on next generate', async () => {
    await writeFileAt(root, 'a.ts')
    const gen = new FolderContextGenerator({ rootDir: root, cacheTtlMs: 60_000 })

    const first = await gen.generate()
    await writeFileAt(root, 'b.ts')
    gen.invalidateCache()
    const second = await gen.generate()

    expect(second).not.toBe(first)
    expect(second.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('regenerate() bypasses cache', async () => {
    await writeFileAt(root, 'a.ts')
    const gen = new FolderContextGenerator({ rootDir: root, cacheTtlMs: 60_000 })

    const first = await gen.generate()
    await writeFileAt(root, 'b.ts')
    const forced = await gen.regenerate()

    expect(forced).not.toBe(first)
    expect(forced.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('respects maxFiles limit', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFileAt(root, `file-${i}.ts`)
    }
    const gen = new FolderContextGenerator({ rootDir: root, maxFiles: 3 })
    const snap = await gen.generate()
    expect(snap.files).toHaveLength(3)
  })

  it('handles empty directory', async () => {
    const gen = new FolderContextGenerator({ rootDir: root })
    const snap = await gen.generate()
    expect(snap.files).toEqual([])
    expect(snap.summary).toMatch(/No matching files/i)
  })

  it('handles directory that does not exist by returning empty snapshot', async () => {
    const gen = new FolderContextGenerator({
      rootDir: join(root, 'does-not-exist'),
    })
    const snap = await gen.generate()
    expect(snap.files).toEqual([])
  })

  it('returns files sorted by score descending', async () => {
    await writeFileAt(root, 'index.ts') // high
    await writeFileAt(root, 'a/b/c.json') // mid-low
    await writeFileAt(root, 'a/b/c/old-test.test.ts') // deeper + test

    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 4 })
    const snap = await gen.generate()

    for (let i = 1; i < snap.files.length; i++) {
      expect(snap.files[i - 1]!.score).toBeGreaterThanOrEqual(snap.files[i]!.score)
    }
    expect(snap.files[0]!.path).toBe('index.ts')
  })

  it('skips node_modules and other ignored directories', async () => {
    await writeFileAt(root, 'a.ts')
    await writeFileAt(root, 'node_modules/dep/index.ts')
    await writeFileAt(root, 'dist/built.js')
    await writeFileAt(root, '.git/HEAD.ts')

    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 5 })
    const files = await gen.scoreFiles()
    expect(files.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('includes reasons for each file score', async () => {
    await writeFileAt(root, 'index.ts')
    const gen = new FolderContextGenerator({ rootDir: root })
    const files = await gen.scoreFiles()
    expect(files[0]!.reasons.length).toBe(4)
    expect(files[0]!.reasons.some((r) => r.includes('entry-point'))).toBe(true)
  })

  it('builds a summary that mentions the root dir and file count', async () => {
    await writeFileAt(root, 'a.ts')
    await writeFileAt(root, 'b.ts')
    const gen = new FolderContextGenerator({ rootDir: root })
    const snap = await gen.generate()
    expect(snap.summary).toContain(root)
    expect(snap.summary).toContain('2')
  })

  it('populates absolutePath on each FileScore', async () => {
    await writeFileAt(root, 'a.ts')
    const gen = new FolderContextGenerator({ rootDir: root })
    const files = await gen.scoreFiles()
    expect(files).toHaveLength(1)
    expect(files[0]!.absolutePath).toBe(join(root, 'a.ts'))
    expect(files[0]!.path).toBe('a.ts')
  })

  it('includes rootDir and ttlMs on the snapshot', async () => {
    await writeFileAt(root, 'a.ts')
    const gen = new FolderContextGenerator({ rootDir: root, cacheTtlMs: 12_345 })
    const snap = await gen.generate()
    expect(snap.rootDir).toBe(root)
    expect(snap.ttlMs).toBe(12_345)
    expect(typeof snap.generatedAt).toBe('number')
  })

  it('uses injected ContextTransferService.serialize() for the summary', async () => {
    await writeFileAt(root, 'index.ts')
    const serialize = (items: readonly { path: string }[]) =>
      `[custom-summary] ${items.map((i) => i.path).join(',')}`
    const gen = new FolderContextGenerator(
      { rootDir: root },
      { serialize },
    )
    const snap = await gen.generate()
    expect(snap.summary).toBe('[custom-summary] index.ts')
  })

  it('falls back to default summary when ContextTransferService.serialize throws', async () => {
    await writeFileAt(root, 'index.ts')
    const gen = new FolderContextGenerator(
      { rootDir: root },
      {
        serialize: () => {
          throw new Error('boom')
        },
      },
    )
    const snap = await gen.generate()
    expect(snap.summary).toContain(root)
  })

  it('uses default extensions when none provided', async () => {
    await writeFileAt(root, 'a.ts')
    await writeFileAt(root, 'b.js')
    await writeFileAt(root, 'c.py')
    await writeFileAt(root, 'd.md')
    await writeFileAt(root, 'e.json')
    await writeFileAt(root, 'skip.txt')

    const gen = new FolderContextGenerator({ rootDir: root })
    const files = await gen.scoreFiles()
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['a.ts', 'b.js', 'c.py', 'd.md', 'e.json'])
  })
})
