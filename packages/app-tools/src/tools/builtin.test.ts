import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import type { ApprovalPayload, ClarificationPayload } from '@dzupagent/hitl-kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createBuiltinToolRegistry,
  type ExecutableDomainTool,
} from './builtin.js'
import type { PmTask, PmTaskStatus } from './pm.js'
import type { TopicRecord } from './topics.js'
import type { WorkflowDefinition, WorkflowRunRecord } from './workflow.js'

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

const SEED_WORKFLOWS: WorkflowDefinition[] = [
  { id: 'wf.ingest', name: 'ingest', description: 'Ingest raw docs', steps: ['fetch', 'parse'] },
  { id: 'wf.summarize', name: 'summarize', steps: ['summarize'] },
]

const SEED_TOPICS: TopicRecord[] = [
  {
    id: 'billing',
    title: 'Billing',
    summary: 'Invoices, payments, refunds',
    tags: ['finance', 'ops'],
  },
  {
    id: 'auth',
    title: 'Authentication',
    summary: 'Login, OAuth, tokens',
    tags: ['security'],
  },
  {
    id: 'rag',
    title: 'Retrieval Augmented Generation',
    summary: 'Index, retrieve, rerank',
    tags: ['ml', 'search'],
  },
]

describe('createBuiltinToolRegistry', () => {
  it('registers all built-in namespaces with correct metadata', () => {
    const { registry, executors } = createBuiltinToolRegistry()
    const names = registry.list().map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'human.approve',
        'human.clarify',
        'pm.create_task',
        'pm.get_task',
        'pm.list_tasks',
        'pm.update_task',
        'project_docs.list',
        'project_docs.read',
        'record.append',
        'record.clear',
        'record.list',
        'topics.get',
        'topics.list',
        'topics.search',
        'workflow.list',
        'workflow.run',
        'workflow.status',
      ].sort(),
    )
    expect(executors.size).toBe(17)
    expect(registry.get('record.append')?.permissionLevel).toBe('write')
    expect(registry.get('human.clarify')?.sideEffects[0]?.type).toBe('sends_notification')
    expect(registry.get('human.approve')?.requiresApproval).toBe(true)
    expect(registry.listByNamespace('pm')).toHaveLength(4)
    expect(registry.listByNamespace('workflow')).toHaveLength(3)
    expect(registry.listByNamespace('topics')).toHaveLength(3)
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

describe('pm.*', () => {
  it('create_task returns the created task with open status and a generated id', async () => {
    const { executors, pmStore } = createBuiltinToolRegistry()
    const create = getExecutor<
      { title: string; description?: string; assignee?: string },
      { task: PmTask }
    >(executors, 'pm.create_task')
    const result = await create.execute({ title: 'ship v1', assignee: 'alice' })
    expect(result.task.title).toBe('ship v1')
    expect(result.task.assignee).toBe('alice')
    expect(result.task.status).toBe('open')
    expect(result.task.id).toMatch(/^task_/)
    expect(pmStore.get(result.task.id)).toEqual(result.task)
  })

  it('update_task mutates state and list_tasks filters by status', async () => {
    const { executors } = createBuiltinToolRegistry()
    const create = getExecutor<{ title: string }, { task: PmTask }>(
      executors,
      'pm.create_task',
    )
    const update = getExecutor<
      { id: string; status?: PmTaskStatus },
      { task: PmTask }
    >(executors, 'pm.update_task')
    const list = getExecutor<{ status?: PmTaskStatus }, { tasks: PmTask[] }>(
      executors,
      'pm.list_tasks',
    )

    const { task: t1 } = await create.execute({ title: 'a' })
    await create.execute({ title: 'b' })
    const { task: updated } = await update.execute({ id: t1.id, status: 'done' })
    expect(updated.status).toBe('done')

    const done = await list.execute({ status: 'done' })
    expect(done.tasks).toHaveLength(1)
    expect(done.tasks[0]?.id).toBe(t1.id)

    const open = await list.execute({ status: 'open' })
    expect(open.tasks).toHaveLength(1)
    expect(open.tasks[0]?.title).toBe('b')
  })

  it('get_task returns null for an unknown id', async () => {
    const { executors } = createBuiltinToolRegistry()
    const get = getExecutor<{ id: string }, { task: PmTask | null }>(
      executors,
      'pm.get_task',
    )
    const result = await get.execute({ id: 'does-not-exist' })
    expect(result.task).toBeNull()
  })

  it('update_task throws when the task does not exist', async () => {
    const { executors } = createBuiltinToolRegistry()
    const update = getExecutor<{ id: string }, { task: PmTask }>(executors, 'pm.update_task')
    await expect(update.execute({ id: 'missing' })).rejects.toThrow(/task not found/)
  })

  it('pm tool definitions have correct permission levels', () => {
    const { registry } = createBuiltinToolRegistry()
    expect(registry.get('pm.create_task')?.permissionLevel).toBe('write')
    expect(registry.get('pm.update_task')?.permissionLevel).toBe('write')
    expect(registry.get('pm.get_task')?.permissionLevel).toBe('read')
    expect(registry.get('pm.list_tasks')?.permissionLevel).toBe('read')
  })
})

describe('workflow.*', () => {
  it('workflow.list returns seeded definitions sorted by name', async () => {
    const { executors } = createBuiltinToolRegistry({ workflows: SEED_WORKFLOWS })
    const list = getExecutor<{ namePrefix?: string }, { workflows: WorkflowDefinition[] }>(
      executors,
      'workflow.list',
    )
    const all = await list.execute({})
    expect(all.workflows.map((w) => w.name)).toEqual(['ingest', 'summarize'])

    const filtered = await list.execute({ namePrefix: 'ing' })
    expect(filtered.workflows).toHaveLength(1)
    expect(filtered.workflows[0]?.id).toBe('wf.ingest')
  })

  it('workflow.run transitions a run to succeeded and exposes it via workflow.status', async () => {
    const { executors } = createBuiltinToolRegistry({ workflows: SEED_WORKFLOWS })
    const run = getExecutor<
      { workflowId: string; input?: Record<string, unknown> },
      { run: WorkflowRunRecord }
    >(executors, 'workflow.run')
    const status = getExecutor<{ runId: string }, { run: WorkflowRunRecord | null }>(
      executors,
      'workflow.status',
    )
    const started = await run.execute({ workflowId: 'wf.ingest', input: { url: 'x' } })
    expect(started.run.workflowId).toBe('wf.ingest')
    expect(started.run.status).toBe('succeeded')
    const after = await status.execute({ runId: started.run.runId })
    expect(after.run?.runId).toBe(started.run.runId)
  })

  it('workflow.run throws for unknown workflow id', async () => {
    const { executors } = createBuiltinToolRegistry({ workflows: SEED_WORKFLOWS })
    const run = getExecutor<{ workflowId: string }, { run: WorkflowRunRecord }>(
      executors,
      'workflow.run',
    )
    await expect(run.execute({ workflowId: 'does.not.exist' })).rejects.toThrow(
      /workflow not found/,
    )
  })

  it('workflow.status returns null for unknown runId', async () => {
    const { executors } = createBuiltinToolRegistry({ workflows: SEED_WORKFLOWS })
    const status = getExecutor<{ runId: string }, { run: WorkflowRunRecord | null }>(
      executors,
      'workflow.status',
    )
    const result = await status.execute({ runId: 'missing' })
    expect(result.run).toBeNull()
  })
})

describe('topics.*', () => {
  it('topics.list returns all seeded topics sorted by title', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const list = getExecutor<{ tag?: string }, { topics: TopicRecord[] }>(
      executors,
      'topics.list',
    )
    const all = await list.execute({})
    expect(all.topics.map((t) => t.id)).toEqual(['auth', 'billing', 'rag'])
  })

  it('topics.list filters by tag', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const list = getExecutor<{ tag?: string }, { topics: TopicRecord[] }>(
      executors,
      'topics.list',
    )
    const finance = await list.execute({ tag: 'finance' })
    expect(finance.topics).toHaveLength(1)
    expect(finance.topics[0]?.id).toBe('billing')
  })

  it('topics.search returns scored matches with the limit applied', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number }[]; query: string }
    >(executors, 'topics.search')
    const result = await search.execute({ query: 'billing invoices' })
    expect(result.query).toBe('billing invoices')
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results[0]?.id).toBe('billing')
    expect(result.results[0]?.score).toBeGreaterThan(0)

    const limited = await search.execute({ query: 'foobar', limit: 1 })
    expect(limited.results).toEqual([])
  })

  it('topics.search gives score 1 for an exact title match', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number }[]; query: string }
    >(executors, 'topics.search')
    // "Billing" is the exact title of the billing topic; titleBoost=0.5 pushes it to 1
    const result = await search.execute({ query: 'Billing' })
    const billingHit = result.results.find((r) => r.id === 'billing')
    expect(billingHit).toBeDefined()
    expect(billingHit?.score).toBe(1)
  })

  it('topics.search returns score > 0 for a partial (substring) match', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number }[]; query: string }
    >(executors, 'topics.search')
    // "invoices" matches billing's summary; "quantum" matches nothing →
    // base = 1/2 = 0.5, no title boost → score = 0.5 (greater than 0, less than 1)
    const result = await search.execute({ query: 'invoices quantum' })
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results[0]?.id).toBe('billing')
    expect(result.results[0]?.score).toBeGreaterThan(0)
    expect(result.results[0]?.score).toBeLessThan(1)
  })

  it('topics.search returns empty results for a completely unrelated query', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number }[]; query: string }
    >(executors, 'topics.search')
    const result = await search.execute({ query: 'xylophone' })
    expect(result.results).toEqual([])
    expect(result.query).toBe('xylophone')
  })

  it('topics.search returns empty results when the catalog is empty', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: [] })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number }[]; query: string }
    >(executors, 'topics.search')
    const result = await search.execute({ query: 'billing' })
    expect(result.results).toEqual([])
  })

  it('topics.search limit restricts output when multiple topics match', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number }[]; query: string }
    >(executors, 'topics.search')
    // "search" appears in the rag topic's tags; "finance" in billing's tags — use a
    // broad query that touches every topic via shared haystack words, then cap with limit
    // "index" is in rag summary, "login" in auth summary, "invoices" in billing summary
    const unlimited = await search.execute({ query: 'index login invoices' })
    expect(unlimited.results.length).toBeGreaterThan(1)
    const limited = await search.execute({ query: 'index login invoices', limit: 1 })
    expect(limited.results).toHaveLength(1)
  })

  it('topics.search includes summary in results when the topic has one', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const search = getExecutor<
      { query: string; limit?: number },
      { results: { id: string; title: string; score: number; summary?: string }[]; query: string }
    >(executors, 'topics.search')
    const result = await search.execute({ query: 'Billing' })
    const billingHit = result.results.find((r) => r.id === 'billing')
    expect(billingHit).toBeDefined()
    expect(billingHit?.summary).toBe('Invoices, payments, refunds')
  })

  it('topics.get returns null for unknown id', async () => {
    const { executors } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const get = getExecutor<{ id: string }, { topic: TopicRecord | null }>(
      executors,
      'topics.get',
    )
    const hit = await get.execute({ id: 'billing' })
    expect(hit.topic?.title).toBe('Billing')
    const miss = await get.execute({ id: 'unknown' })
    expect(miss.topic).toBeNull()
  })
})

describe('human.*', () => {
  it('human.clarify invokes the onClarify callback with a text expectation by default', async () => {
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
    expect(seen[0]?.expected).toBe('text')
    expect(seen[0]?.context).toBe('scoping')
  })

  it('human.clarify switches to choice expectation when choices are supplied', async () => {
    const seen: ClarificationPayload[] = []
    const { executors } = createBuiltinToolRegistry({
      onClarify: (payload) => {
        seen.push(payload)
      },
    })
    const exec = getExecutor<
      { question: string; choices?: string[] },
      { sent: true }
    >(executors, 'human.clarify')
    await exec.execute({ question: 'Pick one', choices: ['a', 'b'] })
    expect(seen[0]?.expected).toBe('choice')
    expect(seen[0]?.choices).toEqual(['a', 'b'])
  })

  it('human.approve invokes the onApprove callback with side-effect metadata', async () => {
    const seen: ApprovalPayload[] = []
    const { executors } = createBuiltinToolRegistry({
      onApprove: (payload) => {
        seen.push(payload)
      },
    })
    const exec = getExecutor<
      { question: string; sideEffects?: string[]; options?: string[] },
      { sent: true }
    >(executors, 'human.approve')
    const result = await exec.execute({
      question: 'Deploy to prod?',
      sideEffects: ['restart'],
      options: ['yes', 'no'],
    })
    expect(result).toEqual({ sent: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('approval')
    expect(seen[0]?.sideEffects).toEqual(['restart'])
    expect(seen[0]?.options).toEqual(['yes', 'no'])
  })
})

describe('record.*', () => {
  it('record.append increments the count for successive appends', async () => {
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

  it('record.list returns a snapshot of appended entries', async () => {
    const { executors } = createBuiltinToolRegistry()
    const append = getExecutor<
      { entry: string; namespace?: string },
      { namespace: string; count: number }
    >(executors, 'record.append')
    const list = getExecutor<
      { namespace?: string },
      { namespace: string; entries: string[] }
    >(executors, 'record.list')
    await append.execute({ entry: 'one' })
    await append.execute({ entry: 'two' })
    const result = await list.execute({})
    expect(result).toEqual({ namespace: 'default', entries: ['one', 'two'] })
  })

  it('record.clear empties the namespace and reports the count cleared', async () => {
    const { executors, recordStore } = createBuiltinToolRegistry()
    const append = getExecutor<
      { entry: string; namespace?: string },
      { namespace: string; count: number }
    >(executors, 'record.append')
    const clear = getExecutor<
      { namespace?: string },
      { namespace: string; cleared: number }
    >(executors, 'record.clear')
    await append.execute({ entry: 'one' })
    await append.execute({ entry: 'two' })
    const result = await clear.execute({})
    expect(result).toEqual({ namespace: 'default', cleared: 2 })
    expect(recordStore.get('default')).toEqual([])
  })

  describe('record.append — file-backed persistence', () => {
    let tmp: string

    beforeAll(async () => {
      tmp = await mkTempDir('app-tools-records-')
    })

    afterAll(async () => {
      await fs.rm(tmp, { recursive: true, force: true })
    })

    it('writes entries as JSONL lines when recordsDir is set', async () => {
      const { executors } = createBuiltinToolRegistry({ recordsDir: tmp })
      const append = getExecutor<
        { entry: string; namespace?: string },
        { namespace: string; count: number }
      >(executors, 'record.append')
      await append.execute({ entry: 'line-a' })
      await append.execute({ entry: 'line-b' })
      await append.execute({ entry: 'alt-entry', namespace: 'other' })

      const defaultFile = path.join(tmp, 'default.jsonl')
      const otherFile = path.join(tmp, 'other.jsonl')
      const defaultLines = (await fs.readFile(defaultFile, 'utf8')).trim().split('\n')
      const otherLines = (await fs.readFile(otherFile, 'utf8')).trim().split('\n')

      expect(defaultLines).toHaveLength(2)
      expect(JSON.parse(defaultLines[0]!).entry).toBe('line-a')
      expect(JSON.parse(defaultLines[1]!).entry).toBe('line-b')
      expect(JSON.parse(otherLines[0]!).entry).toBe('alt-entry')
    })

    it('each JSONL record includes a ts timestamp', async () => {
      const { executors } = createBuiltinToolRegistry({ recordsDir: tmp })
      const append = getExecutor<
        { entry: string },
        { namespace: string; count: number }
      >(executors, 'record.append')
      await append.execute({ entry: 'ts-check' })
      const lines = (await fs.readFile(path.join(tmp, 'default.jsonl'), 'utf8'))
        .trim()
        .split('\n')
      const last = JSON.parse(lines[lines.length - 1]!)
      expect(last.ts).toBeTruthy()
      expect(new Date(last.ts).getFullYear()).toBeGreaterThan(2020)
    })
  })
})

describe('toToolResolver', () => {
  it('resolve returns compiler-grade metadata for a registered tool', async () => {
    const { toToolResolver } = createBuiltinToolRegistry()
    const resolver = toToolResolver()
    const resolved = resolver.resolve('record.append')
    expect(resolved).not.toBeNull()
    expect(resolved?.name).toBe('record.append')
    expect(resolved?.ref).toBe('record.append')
    expect(resolved?.kind).toBe('skill')
    expect(typeof resolved?.handle.execute).toBe('function')
    await expect(resolved?.handle.execute({ entry: 'hello' }, {})).resolves.toBeDefined()
  })

  it('resolve returns null for an unknown tool ref', () => {
    const { toToolResolver } = createBuiltinToolRegistry()
    const resolver = toToolResolver()
    expect(resolver.resolve('unknown.tool')).toBeNull()
  })

  it('listAvailable returns all registered tool names', () => {
    const { toToolResolver, registry } = createBuiltinToolRegistry()
    const resolver = toToolResolver()
    const available = resolver.listAvailable()
    const registered = registry.list().map((d) => d.name).sort()
    expect(available.sort()).toEqual(registered)
  })

  it('resolve finds tools from injected topics catalog', () => {
    const { toToolResolver } = createBuiltinToolRegistry({ topics: SEED_TOPICS })
    const resolver = toToolResolver()
    expect(resolver.resolve('topics.search')?.name).toBe('topics.search')
    expect(resolver.resolve('topics.list')?.name).toBe('topics.list')
  })
})
