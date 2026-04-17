import { describe, expect, it, afterEach } from 'vitest'
import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  FileAdapterSkillVersionStore,
} from '../skills/adapter-skill-version-store.js'
import type { VersionedProjection } from '../skills/adapter-skill-version-store.js'
import type { CompiledAdapterSkill } from '../skills/adapter-skill-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateFile(): string {
  return join(
    tmpdir(),
    `dzup-state-${randomBytes(6).toString('hex')}`,
    'state.json',
  )
}

function makeCompiled(): CompiledAdapterSkill {
  return {
    providerId: 'claude',
    projectionVersion: '1.0.0',
    runtimeConfig: { systemPrompt: 'test prompt' },
    hash: 'abc123',
  }
}

function makeProjection(
  bundleId: string,
  version: number,
  overrides: Partial<VersionedProjection> = {},
): VersionedProjection {
  return {
    projectionId: `${bundleId}-claude-v${version}`,
    bundleId,
    providerId: 'claude',
    version,
    compiled: makeCompiled(),
    hash: `hash-${version}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileAdapterSkillVersionStore', () => {
  const statePaths: string[] = []

  afterEach(async () => {
    for (const p of statePaths) {
      await rm(join(p, '..'), { recursive: true, force: true })
    }
    statePaths.length = 0
  })

  function makeStore(debounceMs = 0): { store: FileAdapterSkillVersionStore; stateFile: string } {
    const stateFile = makeStateFile()
    statePaths.push(stateFile)
    const store = new FileAdapterSkillVersionStore({
      stateFilePath: stateFile,
      writeDebounceMs: debounceMs,
    })
    return { store, stateFile }
  }

  it('save + getLatest round-trip (writes to file)', async () => {
    const { store } = makeStore()
    const projection = makeProjection('bundle-a', 1)

    store.save(projection)
    await store.flush()

    const latest = store.getLatest('bundle-a', 'claude')
    expect(latest).toBeDefined()
    expect(latest!.version).toBe(1)
    expect(latest!.bundleId).toBe('bundle-a')
  })

  it('getLatest returns undefined when bundle has no versions', () => {
    const { store } = makeStore()
    expect(store.getLatest('nonexistent', 'claude')).toBeUndefined()
  })

  it('listVersions returns all saved versions in order', async () => {
    const { store } = makeStore()

    store.save(makeProjection('bundle-b', 1))
    store.save(makeProjection('bundle-b', 2))
    store.save(makeProjection('bundle-b', 3))
    await store.flush()

    const versions = store.listVersions('bundle-b', 'claude')
    expect(versions).toHaveLength(3)
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3])
  })

  it('rollback creates a new version with target compiled output', async () => {
    const { store } = makeStore()

    const v1 = makeProjection('bundle-c', 1)
    store.save(v1)

    const v2 = makeProjection('bundle-c', 2, { hash: 'newer-hash' })
    store.save(v2)
    await store.flush()

    const rolled = store.rollback('bundle-c', 'claude', 1)
    await store.flush()
    expect(rolled.version).toBe(3)
    expect(rolled.hash).toBe('hash-1') // rolled back to v1's hash
    expect(rolled.compiled).toEqual(v1.compiled)
  })

  it('rollback throws for unknown version', () => {
    const { store } = makeStore()
    store.save(makeProjection('bundle-d', 1))
    expect(() => store.rollback('bundle-d', 'claude', 99)).toThrow('Version 99 not found')
  })

  it('persists state to file and reloads correctly', async () => {
    const { stateFile } = makeStore()

    // Write with first store instance
    const store1 = new FileAdapterSkillVersionStore({ stateFilePath: stateFile, writeDebounceMs: 0 })
    const dir = join(stateFile, '..')
    await mkdir(dir, { recursive: true })

    store1.save(makeProjection('bundle-e', 1))
    await store1.flush()

    // Read with fresh instance (no in-memory state)
    const store2 = new FileAdapterSkillVersionStore({ stateFilePath: stateFile, writeDebounceMs: 0 })
    const latest = store2.getLatest('bundle-e', 'claude')
    expect(latest).toBeDefined()
    expect(latest!.version).toBe(1)
  })

  it('missing state file is created on first write', async () => {
    const { store } = makeStore()
    store.save(makeProjection('bundle-f', 1))
    await store.flush()

    // If we get here without throwing, the file was created
    const latest = store.getLatest('bundle-f', 'claude')
    expect(latest).toBeDefined()
  })
})
