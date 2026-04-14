import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DockerSandbox } from '../sandbox/docker-sandbox.js'

describe('DockerSandbox path traversal protection', () => {
  let sandbox: DockerSandbox

  beforeEach(async () => {
    sandbox = new DockerSandbox()
    // Force tempDir creation by uploading a harmless file
    await sandbox.uploadFiles({ 'init.txt': 'init' })
  })

  afterEach(async () => {
    await sandbox.cleanup()
  })

  // --- uploadFiles ---

  it('uploadFiles rejects ../etc/passwd traversal', async () => {
    await expect(
      sandbox.uploadFiles({ '../etc/passwd': 'malicious' }),
    ).rejects.toThrow(/path traversal detected/i)
  })

  it('uploadFiles rejects deeply nested traversal', async () => {
    await expect(
      sandbox.uploadFiles({ 'a/b/../../../../../../etc/shadow': 'malicious' }),
    ).rejects.toThrow(/path traversal detected/i)
  })

  it('uploadFiles rejects absolute paths', async () => {
    await expect(
      sandbox.uploadFiles({ '/etc/passwd': 'malicious' }),
    ).rejects.toThrow(/path traversal detected/i)
  })

  it('uploadFiles allows normal relative paths', async () => {
    // Should not throw
    await sandbox.uploadFiles({
      'src/index.ts': 'console.log("hello")',
      'package.json': '{}',
    })
    const files = await sandbox.downloadFiles(['src/index.ts', 'package.json'])
    expect(files['src/index.ts']).toBe('console.log("hello")')
    expect(files['package.json']).toBe('{}')
  })

  it('uploadFiles allows nested subdirectory paths', async () => {
    await sandbox.uploadFiles({ 'a/b/c/d.txt': 'deep' })
    const files = await sandbox.downloadFiles(['a/b/c/d.txt'])
    expect(files['a/b/c/d.txt']).toBe('deep')
  })

  // --- downloadFiles ---

  it('downloadFiles rejects ../etc/passwd traversal', async () => {
    // downloadFiles wraps read errors silently, but safePath will throw
    // before readFile is called
    await expect(
      sandbox.downloadFiles(['../etc/passwd']),
    ).rejects.toThrow(/path traversal detected/i)
  })

  it('downloadFiles rejects absolute paths', async () => {
    await expect(
      sandbox.downloadFiles(['/etc/passwd']),
    ).rejects.toThrow(/path traversal detected/i)
  })

  it('downloadFiles returns empty for non-existent safe paths', async () => {
    const files = await sandbox.downloadFiles(['nonexistent.txt'])
    expect(files['nonexistent.txt']).toBeUndefined()
  })
})
