import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadDzupAgentConfig,
  getCodexMemoryStrategy,
  getMaxMemoryTokens,
} from '../dzupagent/config.js'
import type { DzupAgentConfig, DzupAgentPaths } from '../types.js'

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dzupagent-config-'))
}

function makePaths(globalDir: string, projectDir: string): DzupAgentPaths {
  return {
    globalDir,
    projectDir,
    projectConfig: join(projectDir, 'config.json'),
    stateFile: join(projectDir, 'state.json'),
  } as DzupAgentPaths
}

describe('loadDzupAgentConfig', () => {
  let globalDir: string
  let projectDir: string

  beforeEach(async () => {
    globalDir = await makeTmpDir()
    projectDir = await makeTmpDir()
  })

  afterEach(async () => {
    await rm(globalDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  it('returns empty config when neither file exists', async () => {
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg).toEqual({
      codex: undefined,
      memory: undefined,
      sync: undefined,
    })
  })

  it('loads global config only', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ memory: { maxTokens: 3000 } }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg.memory?.maxTokens).toBe(3000)
  })

  it('loads project config only', async () => {
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ codex: { memoryStrategy: 'inject-every-turn' } }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg.codex?.memoryStrategy).toBe('inject-every-turn')
  })

  it('project config overrides global config for same key', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ memory: { maxTokens: 1000 } }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ memory: { maxTokens: 5000 } }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg.memory?.maxTokens).toBe(5000)
  })

  it('merges non-overlapping keys from both configs', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ codex: { memoryStrategy: 'inject-every-turn' } }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ memory: { maxTokens: 7000 } }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg.codex?.memoryStrategy).toBe('inject-every-turn')
    expect(cfg.memory?.maxTokens).toBe(7000)
  })

  it('handles malformed JSON gracefully', async () => {
    await writeFile(join(projectDir, 'config.json'), 'not-json{')
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg).toEqual({
      codex: undefined,
      memory: undefined,
      sync: undefined,
    })
  })

  it('handles sync field', async () => {
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ sync: { enabled: true } }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg.sync).toBeDefined()
    expect((cfg.sync as Record<string, unknown>)?.['enabled']).toBe(true)
  })

  it('merges partial codex config', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ codex: { memoryStrategy: 'inject-on-new-thread' } }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ codex: {} }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    // Global key preserved when project override is empty
    expect(cfg.codex?.memoryStrategy).toBe('inject-on-new-thread')
  })

  it('returns undefined codex when neither config has it', async () => {
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ memory: { maxTokens: 1000 } }),
    )
    const cfg = await loadDzupAgentConfig(makePaths(globalDir, projectDir))
    expect(cfg.codex).toBeUndefined()
  })
})

describe('getCodexMemoryStrategy', () => {
  it('returns configured strategy', () => {
    const cfg: DzupAgentConfig = {
      codex: { memoryStrategy: 'inject-every-turn' },
    }
    expect(getCodexMemoryStrategy(cfg)).toBe('inject-every-turn')
  })

  it('returns default when codex is missing', () => {
    expect(getCodexMemoryStrategy({})).toBe('inject-on-new-thread')
  })

  it('returns default when memoryStrategy is missing', () => {
    const cfg: DzupAgentConfig = { codex: {} }
    expect(getCodexMemoryStrategy(cfg)).toBe('inject-on-new-thread')
  })

  it('returns default when codex is undefined', () => {
    const cfg: DzupAgentConfig = { codex: undefined }
    expect(getCodexMemoryStrategy(cfg)).toBe('inject-on-new-thread')
  })
})

describe('getMaxMemoryTokens', () => {
  it('returns configured maxTokens', () => {
    const cfg: DzupAgentConfig = { memory: { maxTokens: 5000 } }
    expect(getMaxMemoryTokens(cfg)).toBe(5000)
  })

  it('returns default 2000 when memory is missing', () => {
    expect(getMaxMemoryTokens({})).toBe(2000)
  })

  it('returns default when memory.maxTokens is missing', () => {
    const cfg: DzupAgentConfig = { memory: {} }
    expect(getMaxMemoryTokens(cfg)).toBe(2000)
  })

  it('returns default when memory is undefined', () => {
    const cfg: DzupAgentConfig = { memory: undefined }
    expect(getMaxMemoryTokens(cfg)).toBe(2000)
  })

  it('accepts zero as valid (not falsy fallback)', () => {
    const cfg: DzupAgentConfig = { memory: { maxTokens: 0 } }
    // Note: this tests whether nullish coalescing correctly distinguishes 0 from undefined
    expect(getMaxMemoryTokens(cfg)).toBe(0)
  })
})
