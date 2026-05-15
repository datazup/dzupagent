import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryVersionedContextBackend } from '../versioned-context-backend.js'

describe('InMemoryVersionedContextBackend', () => {
  let backend: InMemoryVersionedContextBackend

  beforeEach(() => {
    backend = new InMemoryVersionedContextBackend()
  })

  it('returns undefined for missing artifact', async () => {
    const result = await backend.get({ kind: 'prompt', tenantId: 'tenant-1', artifactId: 'p1', stage: 'dev' })
    expect(result).toBeUndefined()
  })

  it('puts and gets an artifact', async () => {
    await backend.put({
      artifactId: 'p1',
      kind: 'prompt',
      tenantId: 'tenant-1',
      version: '1.0.0',
      stage: 'dev',
      content: { text: 'hello' },
    })
    const artifact = await backend.get({ kind: 'prompt', tenantId: 'tenant-1', artifactId: 'p1', stage: 'dev' })
    expect(artifact?.content).toEqual({ text: 'hello' })
    expect(artifact?.version).toBe('1.0.0')
  })

  it('upsert preserves createdAt on second put', async () => {
    await backend.put({ artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '1', stage: 'dev', content: 'v1' })
    const first = await backend.get({ kind: 'prompt', tenantId: 't', artifactId: 'p1', stage: 'dev' })

    await new Promise(r => setTimeout(r, 5))
    await backend.put({ artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '2', stage: 'dev', content: 'v2' })
    const second = await backend.get({ kind: 'prompt', tenantId: 't', artifactId: 'p1', stage: 'dev' })

    expect(second?.createdAt).toBe(first?.createdAt)
    expect(second?.updatedAt).toBeGreaterThan(first!.updatedAt)
    expect(second?.content).toBe('v2')
  })

  it('lists artifacts by tenantId', async () => {
    await backend.put({ artifactId: 'a', kind: 'prompt', tenantId: 't1', version: '1', stage: 'dev', content: {} })
    await backend.put({ artifactId: 'b', kind: 'skill', tenantId: 't1', version: '1', stage: 'dev', content: {} })
    await backend.put({ artifactId: 'c', kind: 'prompt', tenantId: 't2', version: '1', stage: 'dev', content: {} })

    const t1 = await backend.list({ tenantId: 't1' })
    expect(t1).toHaveLength(2)

    const prompts = await backend.list({ tenantId: 't1', kind: 'prompt' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.artifactId).toBe('a')
  })

  it('promotes dev → staging', async () => {
    await backend.put({ artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '1', stage: 'dev', content: 'hello' })
    const promoted = await backend.promote({ kind: 'prompt', tenantId: 't', artifactId: 'p1', fromStage: 'dev' })
    expect(promoted.stage).toBe('staging')

    const inStaging = await backend.get({ kind: 'prompt', tenantId: 't', artifactId: 'p1', stage: 'staging' })
    expect(inStaging?.content).toBe('hello')
  })

  it('promotes staging → prod', async () => {
    await backend.put({ artifactId: 'p1', kind: 'policy', tenantId: 't', version: '1', stage: 'staging', content: {} })
    await backend.promote({ kind: 'policy', tenantId: 't', artifactId: 'p1', fromStage: 'staging' })
    const inProd = await backend.get({ kind: 'policy', tenantId: 't', artifactId: 'p1', stage: 'prod' })
    expect(inProd?.stage).toBe('prod')
  })

  it('throws when promoting from prod', async () => {
    await backend.put({ artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '1', stage: 'prod', content: {} })
    await expect(backend.promote({ kind: 'prompt', tenantId: 't', artifactId: 'p1', fromStage: 'prod' }))
      .rejects.toThrow(/already at production/)
  })

  it('throws when promote requires benchmark and none set', async () => {
    await backend.put({ artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '1', stage: 'dev', content: {} })
    await expect(
      backend.promote({ kind: 'prompt', tenantId: 't', artifactId: 'p1', fromStage: 'dev', options: { requireBenchmark: true } }),
    ).rejects.toThrow(/benchmarkId/)
  })

  it('promotes successfully when benchmarkId is set', async () => {
    await backend.put({
      artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '1', stage: 'dev', content: {},
      benchmarkId: 'bench-001',
    })
    const promoted = await backend.promote({
      kind: 'prompt', tenantId: 't', artifactId: 'p1', fromStage: 'dev',
      options: { requireBenchmark: true },
    })
    expect(promoted.stage).toBe('staging')
  })

  it('delete removes the artifact', async () => {
    await backend.put({ artifactId: 'p1', kind: 'prompt', tenantId: 't', version: '1', stage: 'dev', content: {} })
    await backend.delete({ kind: 'prompt', tenantId: 't', artifactId: 'p1', stage: 'dev' })
    expect(await backend.get({ kind: 'prompt', tenantId: 't', artifactId: 'p1', stage: 'dev' })).toBeUndefined()
  })

  it('enforces tenant isolation in list()', async () => {
    await backend.put({ artifactId: 'shared-name', kind: 'memory', tenantId: 'tenant-A', version: '1', stage: 'dev', content: 'A' })
    await backend.put({ artifactId: 'shared-name', kind: 'memory', tenantId: 'tenant-B', version: '1', stage: 'dev', content: 'B' })

    const a = await backend.list({ tenantId: 'tenant-A' })
    expect(a).toHaveLength(1)
    expect(a[0]!.content).toBe('A')
  })
})
