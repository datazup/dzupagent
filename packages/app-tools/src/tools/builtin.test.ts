import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ClarificationPayload } from '@dzupagent/hitl-kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBuiltinToolRegistry, type ExecutableDomainTool } from './builtin.js'

async function mkTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function getExecutor<TInput, TOutput>(
  executors: Map<string, ExecutableDomainTool>,
  name: string,
): ExecutableDomainTool<TInput, TOutput> {
  const exec = executors.get(name)
  if (!exec) {
    throw new Error(`executor ${name} not registered`)
  }
  return exec as unknown as ExecutableDomainTool<TInput, TOutput>
}

describe('createBuiltinToolRegistry', () => {
  it('registers all five tools with correct metadata', () => {
    const { registry, executors } = createBuiltinToolRegistry()
    const names = registry.list().map((t) => t.name).sort()
    expect(names).toEqual([
      'human.clarify',
      'project_docs.list',
      'project_docs.read',
      'record.append',
      'topics.search',
    ])
    expect(executors.size).toBe(5)
    expect(registry.get('record.append')?.permissionLevel).toBe('write')
    expect(registry.get('human.clarify')?.sideEffects[0]?.type).toBe('sends_notification')
  })
})

describe('project_docs.list', () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await mkTempDir('app-tools-list-')
    await fs.mkdir(path.join(tmp, 'docs'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'docs', 'a.md'), '# A')
    await fs.writeFile(path.join(tmp, 'docs', 'b.md'), '# B')
    await fs.writeFile(path.join(tmp, 'README.txt'), 'readme')
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('lists files matching a glob pattern', async () => {
    const { executors } = createBuiltinToolRegistry({ rootDir: tmp })
    const exec = getExecutor<{ pattern: string }, { files: string[] }>(
      executors,
      'project_docs.list',
    )
    const result = await exec.execute({ pattern: '**/*.md' })
    expect(result.files).toEqual(['docs/a.md', 'docs/b.md'])
  })
})

describe('project_docs.read', () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await mkTempDir('app-tools-read-')
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'hello world')
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('reads a file under rootDir', async () => {
    const { executors } = createBuiltinToolRegistry({ rootDir: tmp })
    const exec = getExecutor<{ path: string }, { content: string }>(
      executors,
      'project_docs.read',
    )
    const result = await exec.execute({ path: 'hello.txt' })
    expect(result.content).toBe('hello world')
  })

  it('refuses paths that escape rootDir', async () => {
    const { executors } = createBuiltinToolRegistry({ rootDir: tmp })
    const exec = getExecutor<{ path: string }, { content: string }>(
      executors,
      'project_docs.read',
    )
    await expect(exec.execute({ path: '../etc/passwd' })).rejects.toThrow(/outside rootDir/)
  })
})

describe('topics.search', () => {
  it('returns an empty results array and echoes the query', async () => {
    const { executors } = createBuiltinToolRegistry()
    const exec = getExecutor<
      { query: string; limit?: number },
      { results: unknown[]; query: string }
    >(executors, 'topics.search')
    const result = await exec.execute({ query: 'billing', limit: 5 })
    expect(result.results).toEqual([])
    expect(result.query).toBe('billing')
  })
})

describe('human.clarify', () => {
  it('invokes the onClarify callback with a ClarificationPayload', async () => {
    const seen: ClarificationPayload[] = []
    const { executors } = createBuiltinToolRegistry({
      onClarify: (payload) => {
        seen.push(payload)
      },
    })
    const exec = getExecutor<
      { question: string; context?: string },
      { sent: true }
    >(executors, 'human.clarify')
    const result = await exec.execute({ question: 'Which DB?', context: 'scoping' })
    expect(result).toEqual({ sent: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('clarification')
    expect(seen[0]?.question).toBe('Which DB?')
    expect(seen[0]?.context).toBe('scoping')
    expect(seen[0]?.expected).toBe('text')
  })
})

describe('record.append', () => {
  it('increments the count for successive appends', async () => {
    const { executors, recordStore } = createBuiltinToolRegistry()
    const exec = getExecutor<
      { entry: string; namespace?: string },
      { namespace: string; count: number }
    >(executors, 'record.append')
    const first = await exec.execute({ entry: 'one' })
    const second = await exec.execute({ entry: 'two' })
    const nsScoped = await exec.execute({ entry: 'x', namespace: 'alt' })
    expect(first).toEqual({ namespace: 'default', count: 1 })
    expect(second).toEqual({ namespace: 'default', count: 2 })
    expect(nsScoped).toEqual({ namespace: 'alt', count: 1 })
    expect(recordStore.get('default')).toEqual(['one', 'two'])
    expect(recordStore.get('alt')).toEqual(['x'])
  })
})
