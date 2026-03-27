import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  validateProjectName,
  detectPackageManager,
  applyOverlay,
  getInstallCommand,
  getDevCommand,
} from '../utils.js'

describe('validateProjectName', () => {
  it('accepts valid lowercase names', () => {
    expect(validateProjectName('my-project')).toBeNull()
    expect(validateProjectName('my-agent-123')).toBeNull()
    expect(validateProjectName('agent')).toBeNull()
  })

  it('accepts scoped package names', () => {
    expect(validateProjectName('@my-org/my-project')).toBeNull()
  })

  it('rejects empty names', () => {
    expect(validateProjectName('')).toBeTruthy()
    expect(validateProjectName('   ')).toBeTruthy()
  })

  it('rejects names starting with . or _', () => {
    expect(validateProjectName('.hidden')).toBeTruthy()
    expect(validateProjectName('_private')).toBeTruthy()
  })

  it('rejects uppercase names', () => {
    expect(validateProjectName('MyProject')).toBeTruthy()
  })

  it('rejects names with invalid characters', () => {
    expect(validateProjectName('my project')).toBeTruthy()
    expect(validateProjectName('my@project')).toBeTruthy()
  })

  it('rejects names longer than 214 characters', () => {
    const longName = 'a'.repeat(215)
    expect(validateProjectName(longName)).toBeTruthy()
  })
})

describe('detectPackageManager', () => {
  it('returns npm as default when no lockfiles present', () => {
    const result = detectPackageManager('/tmp/nonexistent-dir')
    expect(result).toBe('npm')
  })
})

describe('applyOverlay', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-overlay-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates files at the specified paths', async () => {
    const created = await applyOverlay(tempDir, [
      { path: 'src/hello.ts', content: 'export const x = 1' },
      { path: 'config/app.json', content: '{}' },
    ])

    expect(created).toEqual(['src/hello.ts', 'config/app.json'])

    const content = await readFile(join(tempDir, 'src/hello.ts'), 'utf-8')
    expect(content).toBe('export const x = 1')
  })

  it('creates nested directories automatically', async () => {
    await applyOverlay(tempDir, [
      { path: 'deeply/nested/dir/file.ts', content: 'hello' },
    ])

    const content = await readFile(join(tempDir, 'deeply/nested/dir/file.ts'), 'utf-8')
    expect(content).toBe('hello')
  })

  it('handles empty overlay list', async () => {
    const created = await applyOverlay(tempDir, [])
    expect(created).toEqual([])
  })
})

describe('getInstallCommand', () => {
  it('returns correct command for npm', () => {
    expect(getInstallCommand('npm')).toBe('npm install')
  })

  it('returns correct command for yarn', () => {
    expect(getInstallCommand('yarn')).toBe('yarn')
  })

  it('returns correct command for pnpm', () => {
    expect(getInstallCommand('pnpm')).toBe('pnpm install')
  })
})

describe('getDevCommand', () => {
  it('returns correct command for npm', () => {
    expect(getDevCommand('npm')).toBe('npm run dev')
  })

  it('returns correct command for yarn', () => {
    expect(getDevCommand('yarn')).toBe('yarn dev')
  })

  it('returns correct command for pnpm', () => {
    expect(getDevCommand('pnpm')).toBe('pnpm dev')
  })
})

// Need to import these for beforeEach/afterEach
import { beforeEach, afterEach } from 'vitest'
