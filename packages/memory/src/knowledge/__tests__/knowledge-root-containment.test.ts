import { test, expect } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, symlink, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withContainedFile } from '../../knowledge/contained-file.js'
import { FilesystemKnowledgeStore } from '../../knowledge/filesystem-knowledge-store.js'
import { snapshotPath } from '../../knowledge/knowledge-paths.js'

test('knowledge paths reject ambiguous scopes and pin ancestors of the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-boundary-'))
  try {
    const store = new FilesystemKnowledgeStore({ rootDir: root })
    const read = async (scope: string) => { for await (const entry of store.query({ scope })) void entry }
    for (const scope of ['run:../escape', 'repo:a/b', 'run:a:b', 'global:extra', 'run:']) await expect(read(scope)).rejects.toThrow(/Invalid scope/)
    expect(snapshotPath(root, 'global', 'finding', 'a/b')).not.toBe(snapshotPath(root, 'global', 'finding', 'a_b'))
    expect(() => snapshotPath(root, 'global', '../finding', 'key')).toThrow(/kind/)
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'alias'))
    await expect(withContainedFile(join(root, 'alias', 'nested'), join(root, 'alias', 'nested', 'file'), true, constants.O_CREAT | constants.O_WRONLY, async () => undefined)).rejects.toThrow(/symlink/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a symlink occupying the historical lock path cannot touch an outside directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-lock-boundary-'))
  const outside = await mkdtemp(join(tmpdir(), 'knowledge-outside-'))
  try {
    await writeFile(join(outside, 'marker'), 'retained')
    await symlink(outside, join(root, 'global.lock'))
    const before = await stat(outside)
    const store = new FilesystemKnowledgeStore({ rootDir: root })
    const entry = { id: 'entry', runId: 'run', repo: null, kind: 'finding' as const, key: 'key', version: 1, authorWorkerId: null, parentId: null, createdAt: '2026-10-07T00:00:00.000Z', supersededAt: null, payload: { category: 'hotspot' as const, location: 'fixture:1', summary: 'fixture', evidence: [], confidence: 1 }, tags: [] }
    await expect(store.append('global', entry)).rejects.toThrow()
    expect(await readFile(join(outside, 'marker'), 'utf8')).toBe('retained')
    expect((await stat(outside)).mtimeMs).toBe(before.mtimeMs)
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
}, 10_000)
