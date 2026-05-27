import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadDzupAgentConfig,
  loadConfig,
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
    workspaceDir: undefined,
    projectDir,
    projectConfig: join(projectDir, 'config.json'),
    stateFile: join(projectDir, 'state.json'),
  } as DzupAgentPaths
}

function makeTieredPaths(
  globalDir: string,
  workspaceDir: string,
  projectDir: string,
): DzupAgentPaths {
  return {
    globalDir,
    workspaceDir,
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
    expect(cfg).toEqual({})
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
    expect(cfg).toEqual({})
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

describe('loadDzupAgentConfig — tiered global < workspace < project', () => {
  let globalDir: string
  let workspaceDir: string
  let projectDir: string

  beforeEach(async () => {
    globalDir = await makeTmpDir()
    workspaceDir = await makeTmpDir()
    projectDir = await makeTmpDir()
  })

  afterEach(async () => {
    await rm(globalDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  it('merges all 5 new namespaces across global < workspace < project', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({
        provider: { default: 'claude', claude: { tier: 'global' } },
        mcp: { servers: { fs: { from: 'global' } } },
        monitor: { enabled: false, level: 'global' },
        rules: { rules: ['global-rule'], from: 'global' },
        privacy: { redactSecrets: true, from: 'global' },
      }),
    )
    await writeFile(
      join(workspaceDir, 'config.json'),
      JSON.stringify({
        provider: { default: 'codex' },
        monitor: { enabled: true },
        rules: { rules: ['ws-rule'] },
      }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({
        privacy: { redactSecrets: false },
        mcp: { servers: { fs: { from: 'project' } } },
      }),
    )

    const cfg = await loadDzupAgentConfig(
      makeTieredPaths(globalDir, workspaceDir, projectDir),
    )

    // provider: workspace overrides global `default`, global keys preserved
    expect(cfg.provider?.default).toBe('codex')
    expect(cfg.provider?.['claude']).toEqual({ tier: 'global' })
    // mcp: project wins
    expect(cfg.mcp?.servers).toEqual({ fs: { from: 'project' } })
    // monitor: workspace overrides global `enabled`, global key preserved
    expect(cfg.monitor?.enabled).toBe(true)
    expect(cfg.monitor?.['level']).toBe('global')
    // rules: workspace overrides global
    expect(cfg.rules?.rules).toEqual(['ws-rule'])
    expect(cfg.rules?.['from']).toBe('global')
    // privacy: project overrides global
    expect(cfg.privacy?.redactSecrets).toBe(false)
    expect(cfg.privacy?.['from']).toBe('global')
  })

  it('keeps codex/memory/sync callers working across all three tiers', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({
        codex: { memoryStrategy: 'inject-on-new-thread' },
        memory: { maxTokens: 1000, includeGlobal: true },
        sync: { onProjectOpen: false },
      }),
    )
    await writeFile(
      join(workspaceDir, 'config.json'),
      JSON.stringify({ memory: { maxTokens: 4000 } }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({
        codex: { memoryStrategy: 'inject-always' },
        sync: { onProjectOpen: true },
      }),
    )

    const cfg = await loadDzupAgentConfig(
      makeTieredPaths(globalDir, workspaceDir, projectDir),
    )

    // codex: project wins
    expect(getCodexMemoryStrategy(cfg)).toBe('inject-always')
    // memory: workspace overrides global maxTokens, global includeGlobal preserved
    expect(getMaxMemoryTokens(cfg)).toBe(4000)
    expect(cfg.memory?.includeGlobal).toBe(true)
    // sync: project wins
    expect((cfg.sync as Record<string, unknown>)?.['onProjectOpen']).toBe(true)
  })

  it('preserves $schema from the winning (highest) tier', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ $schema: 'dzupagent-config/v1', provider: { default: 'claude' } }),
    )
    await writeFile(
      join(workspaceDir, 'config.json'),
      JSON.stringify({ $schema: 'dzupagent-config/v1', provider: { default: 'codex' } }),
    )

    const cfg = await loadDzupAgentConfig(
      makeTieredPaths(globalDir, workspaceDir, projectDir),
    )
    expect(cfg.$schema).toBe('dzupagent-config/v1')
    expect(cfg.provider?.default).toBe('codex')
  })

  it('inherits $schema from a lower tier when higher tiers omit it', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ $schema: 'dzupagent-config/v1' }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ provider: { default: 'codex' } }),
    )

    const cfg = await loadDzupAgentConfig(
      makeTieredPaths(globalDir, workspaceDir, projectDir),
    )
    expect(cfg.$schema).toBe('dzupagent-config/v1')
  })

  it('gracefully skips a missing workspace tier (only global + project present)', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ monitor: { enabled: false } }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ monitor: { enabled: true } }),
    )
    // workspaceDir points at a real but empty dir → no config.json there
    const cfg = await loadDzupAgentConfig(
      makeTieredPaths(globalDir, workspaceDir, projectDir),
    )
    expect(cfg.monitor?.enabled).toBe(true)
  })

  it('skips the workspace tier when workspaceDir equals projectDir', async () => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ rules: { rules: ['global'] } }),
    )
    await writeFile(
      join(projectDir, 'config.json'),
      JSON.stringify({ rules: { rules: ['project'] } }),
    )
    const cfg = await loadDzupAgentConfig(
      makeTieredPaths(globalDir, projectDir, projectDir),
    )
    expect(cfg.rules?.rules).toEqual(['project'])
  })
})

describe('loadConfig — projectDir convenience wrapper', () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = await makeTmpDir()
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('loads project-tier config from a bare project directory', async () => {
    await mkdir(join(projectDir, '.dzupagent'), { recursive: true })
    await writeFile(
      join(projectDir, '.dzupagent', 'config.json'),
      JSON.stringify({ $schema: 'dzupagent-config/v1', provider: { default: 'codex' } }),
    )
    const cfg = await loadConfig(projectDir)
    expect(cfg.$schema).toBe('dzupagent-config/v1')
    expect(cfg.provider?.default).toBe('codex')
  })

  it('merges an explicit workspaceDir override under the project tier', async () => {
    const workspaceRoot = await makeTmpDir()
    try {
      await mkdir(join(workspaceRoot, '.dzupagent'), { recursive: true })
      await writeFile(
        join(workspaceRoot, '.dzupagent', 'config.json'),
        JSON.stringify({ monitor: { enabled: false, level: 'ws' } }),
      )
      await mkdir(join(projectDir, '.dzupagent'), { recursive: true })
      await writeFile(
        join(projectDir, '.dzupagent', 'config.json'),
        JSON.stringify({ monitor: { enabled: true } }),
      )
      const cfg = await loadConfig(projectDir, workspaceRoot)
      // project overrides workspace `enabled`; workspace `level` preserved
      expect(cfg.monitor?.enabled).toBe(true)
      expect(cfg.monitor?.['level']).toBe('ws')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
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
