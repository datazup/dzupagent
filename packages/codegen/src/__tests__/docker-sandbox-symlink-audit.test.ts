import { it, expect } from 'vitest'
import { mkdtemp, symlink, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DockerSandbox } from '../sandbox/docker-sandbox.js'
it('refuses directory and final-file symlinks on upload and download', async () => {
  const sandbox = new DockerSandbox()
  const outside = await mkdtemp(join(tmpdir(), 'sandbox-audit-outside-'))
  try {
    await sandbox.uploadFiles({ 'seed': 'original' })
    const root = (sandbox as unknown as { tempDir: string }).tempDir
    await symlink(outside, join(root, 'link'))
    await expect(sandbox.uploadFiles({ 'link/escape': 'bad' })).rejects.toThrow(/symlink/)
    await expect(sandbox.downloadFiles(['link/escape'])).rejects.toThrow(/symlink/)
    await expect(readFile(join(outside, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' })
    await symlink(join(root, 'seed'), join(root, 'alias'))
    await expect(sandbox.uploadFiles({ alias: 'bad' })).rejects.toThrow(/symlink/)
    expect((await sandbox.downloadFiles(['seed'])).seed).toBe('original')
  } finally { await sandbox.cleanup(); await rm(outside, { recursive: true, force: true }) }
})
