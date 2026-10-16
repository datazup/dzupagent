import { test, expect } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withContainedFile } from '../sandbox/contained-file.js'

test('configured root ancestors cannot redirect staging through a symlink', async () => {
  const base = await mkdtemp(join(tmpdir(), 'root-containment-'))
  try {
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'victim'), 'original')
    await symlink(join(base, 'outside'), join(base, 'alias'))
    await expect(withContainedFile(join(base, 'alias', 'nested'), join(base, 'alias', 'nested', 'file'), true, constants.O_CREAT | constants.O_WRONLY, async file => file.writeFile('bad'))).rejects.toThrow(/symlink/)
    expect(await readFile(join(base, 'outside', 'victim'), 'utf8')).toBe('original')
    await expect(readFile(join(base, 'outside', 'nested', 'file'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(withContainedFile(base, join(base, '..', 'escape'), true, constants.O_CREAT | constants.O_WRONLY, async () => undefined)).rejects.toThrow(/traversal/)
    await expect(withContainedFile(base, base, false, constants.O_RDONLY, async () => undefined)).rejects.toThrow(/traversal/)
    await expect(withContainedFile(base, join(base, 'outside'), false, constants.O_RDONLY, async () => undefined)).rejects.toThrow(/regular file/)
  } finally { await rm(base, { recursive: true, force: true }) }
})
