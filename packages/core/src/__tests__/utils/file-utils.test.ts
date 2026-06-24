import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFileOrDefault, readTextFileOrDefault } from '../../utils/file-utils.js'

describe('readJsonFileOrDefault', () => {
  it('returns the parsed JSON when the file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-file-utils-'))
    const path = join(dir, 'data.json')
    await writeFile(path, JSON.stringify({ a: 1 }), 'utf8')
    const result = await readJsonFileOrDefault(path, { a: 0 })
    expect(result).toEqual({ a: 1 })
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the default on ENOENT (missing file)', async () => {
    const fallback = { items: [] as string[] }
    const result = await readJsonFileOrDefault(
      join(tmpdir(), 'does-not-exist-forge-xyz.json'),
      fallback,
    )
    expect(result).toBe(fallback)
  })

  it('logs at debug level on ENOENT', async () => {
    const logger = { debug: vi.fn(), error: vi.fn() }
    await readJsonFileOrDefault(join(tmpdir(), 'missing-forge-debug.json'), {}, { logger })
    expect(logger.debug).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('rethrows a JSON syntax error rather than masking it as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-file-utils-'))
    const path = join(dir, 'broken.json')
    await writeFile(path, '{ not valid json', 'utf8')
    await expect(readJsonFileOrDefault(path, {})).rejects.toBeInstanceOf(SyntaxError)
    await rm(dir, { recursive: true, force: true })
  })

  it('rethrows non-ENOENT IO errors and logs them at error level', async () => {
    // A directory passed where a file is expected -> EISDIR (not ENOENT).
    const dir = await mkdtemp(join(tmpdir(), 'forge-file-utils-'))
    const subdir = join(dir, 'a-directory')
    await mkdir(subdir)
    const logger = { debug: vi.fn(), error: vi.fn() }
    await expect(readTextFileOrDefault(subdir, 'default', { logger })).rejects.toBeDefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.debug).not.toHaveBeenCalled()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('readTextFileOrDefault', () => {
  it('returns the file text when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-file-utils-'))
    const path = join(dir, 'note.txt')
    await writeFile(path, 'hello', 'utf8')
    expect(await readTextFileOrDefault(path, 'fallback')).toBe('hello')
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the default on ENOENT', async () => {
    expect(
      await readTextFileOrDefault(join(tmpdir(), 'missing-forge-text.txt'), 'fallback'),
    ).toBe('fallback')
  })
})
