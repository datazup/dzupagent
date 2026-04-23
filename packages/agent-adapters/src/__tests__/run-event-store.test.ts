import { describe, it, expect, afterEach } from 'vitest'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RunEventStore } from '../runs/run-event-store.js'
import { runLogRoot } from '../runs/run-log-root.js'
import type { RawAgentEvent, AgentArtifactEvent, RunSummary } from '../runs/run-event-store.js'
import type { AgentEvent } from '../types.js'

const cleanup: string[] = []

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'run-event-store-test-'))
  cleanup.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function makeStore(projectDir: string, runId = 'test-run-id'): RunEventStore {
  return new RunEventStore({ runId, projectDir })
}

describe('RunEventStore', () => {
  describe('open()', () => {
    it('creates the run directory', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-open-test'
      const store = makeStore(projectDir, runId)

      await store.open()

      const { stat } = await import('node:fs/promises')
      const info = await stat(runLogRoot(projectDir, runId))
      expect(info.isDirectory()).toBe(true)
    })

    it('creates nested run directories when parent does not exist', async () => {
      const projectDir = await makeTmpDir()
      const deepProjectDir = join(projectDir, 'nested', 'project')
      const runId = 'run-nested'
      const store = makeStore(deepProjectDir, runId)

      await store.open()

      const { stat } = await import('node:fs/promises')
      const info = await stat(runLogRoot(deepProjectDir, runId))
      expect(info.isDirectory()).toBe(true)
    })
  })

  describe('appendRaw()', () => {
    it('writes a JSONL line to raw-events.jsonl', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-raw-test'
      const store = makeStore(projectDir, runId)
      await store.open()

      const event: RawAgentEvent = {
        providerId: 'claude',
        runId,
        sessionId: 'sess-1',
        timestamp: 1_000_000,
        source: 'stdout',
        payload: { type: 'message', content: 'hello' },
      }
      await store.appendRaw(event)

      const filePath = join(runLogRoot(projectDir, runId), 'raw-events.jsonl')
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual(event)
    })

    it('buffers events written before open() and flushes on open()', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-buffer-test'
      const store = makeStore(projectDir, runId)

      const event: RawAgentEvent = {
        providerId: 'gemini',
        runId,
        timestamp: 2_000_000,
        source: 'stderr',
        payload: 'buffered',
      }
      // Write before open
      await store.appendRaw(event)

      // Now open — should flush
      await store.open()

      const filePath = join(runLogRoot(projectDir, runId), 'raw-events.jsonl')
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual(event)
    })

    it('writes multiple raw events as separate lines', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-multi-raw'
      const store = makeStore(projectDir, runId)
      await store.open()

      const events: RawAgentEvent[] = [
        { providerId: 'claude', runId, timestamp: 1, source: 'stdout', payload: { n: 1 } },
        { providerId: 'claude', runId, timestamp: 2, source: 'stdout', payload: { n: 2 } },
        { providerId: 'claude', runId, timestamp: 3, source: 'stdout', payload: { n: 3 } },
      ]
      for (const ev of events) {
        await store.appendRaw(ev)
      }

      const filePath = join(runLogRoot(projectDir, runId), 'raw-events.jsonl')
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(3)
      for (let i = 0; i < events.length; i++) {
        expect(JSON.parse(lines[i]!)).toEqual(events[i])
      }
    })
  })

  describe('appendNormalized()', () => {
    it('writes to normalized-events.jsonl', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-norm-test'
      const store = makeStore(projectDir, runId)
      await store.open()

      const event: AgentEvent = {
        type: 'adapter:message',
        providerId: 'claude',
        content: 'Hello from agent',
        role: 'assistant',
        timestamp: 3_000_000,
      }
      await store.appendNormalized(event)

      const filePath = join(runLogRoot(projectDir, runId), 'normalized-events.jsonl')
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual(event)
    })

    it('buffers normalized events written before open()', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-norm-buffer'
      const store = makeStore(projectDir, runId)

      const event: AgentEvent = {
        type: 'adapter:stream_delta',
        providerId: 'gemini',
        content: 'delta text',
        timestamp: 999,
      }
      await store.appendNormalized(event)
      await store.open()

      const filePath = join(runLogRoot(projectDir, runId), 'normalized-events.jsonl')
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual(event)
    })
  })

  describe('appendArtifact()', () => {
    it('writes to artifacts.jsonl', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-artifact-test'
      const store = makeStore(projectDir, runId)
      await store.open()

      const event: AgentArtifactEvent = {
        runId,
        providerId: 'claude',
        timestamp: 4_000_000,
        artifactType: 'transcript',
        path: '/project/.dzupagent/transcripts/run.jsonl',
        action: 'created',
        metadata: { lines: 42 },
      }
      await store.appendArtifact(event)

      const filePath = join(runLogRoot(projectDir, runId), 'artifacts.jsonl')
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual(event)
    })
  })

  describe('close()', () => {
    it('writes a valid summary.json', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-close-test'
      const store = makeStore(projectDir, runId)
      await store.open()

      const summary: RunSummary = {
        runId,
        providerId: 'claude',
        sessionId: 'sess-close',
        startedAt: 1_000_000,
        completedAt: 1_005_000,
        durationMs: 5_000,
        toolCallCount: 3,
        artifactCount: 1,
        tokenUsage: { inputTokens: 100, outputTokens: 200, costCents: 5 },
        status: 'completed',
      }
      await store.close(summary)

      const summaryPath = join(runLogRoot(projectDir, runId), 'summary.json')
      const raw = await readFile(summaryPath, 'utf8')
      const parsed = JSON.parse(raw) as RunSummary
      expect(parsed).toEqual(summary)
    })

    it('writes summary.json with failed status and errorMessage', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-failed-summary'
      const store = makeStore(projectDir, runId)
      await store.open()

      const summary: RunSummary = {
        runId,
        providerId: 'codex',
        startedAt: 2_000_000,
        completedAt: 2_001_000,
        durationMs: 1_000,
        toolCallCount: 0,
        artifactCount: 0,
        errorMessage: 'Process exited with code 1',
        status: 'failed',
      }
      await store.close(summary)

      const summaryPath = join(runLogRoot(projectDir, runId), 'summary.json')
      const parsed = JSON.parse(await readFile(summaryPath, 'utf8')) as RunSummary
      expect(parsed.status).toBe('failed')
      expect(parsed.errorMessage).toBe('Process exited with code 1')
    })

    it('produces valid JSON in summary.json (pretty-printed)', async () => {
      const projectDir = await makeTmpDir()
      const runId = 'run-pretty-summary'
      const store = makeStore(projectDir, runId)
      await store.open()

      const summary: RunSummary = {
        runId,
        providerId: 'gemini',
        startedAt: 0,
        completedAt: 100,
        durationMs: 100,
        toolCallCount: 0,
        artifactCount: 0,
        status: 'completed',
      }
      await store.close(summary)

      const summaryPath = join(runLogRoot(projectDir, runId), 'summary.json')
      const raw = await readFile(summaryPath, 'utf8')
      // Pretty-printed JSON contains newlines
      expect(raw).toContain('\n')
      // Must be parseable
      expect(() => JSON.parse(raw)).not.toThrow()
    })
  })

  describe('error resilience', () => {
    it('does not throw when appendRaw is called before open on a bad path', async () => {
      // Just test the pre-open buffer path — no disk I/O until open
      const store = new RunEventStore({ runId: 'x', projectDir: '/nonexistent/path' })
      const event: RawAgentEvent = {
        providerId: 'claude',
        runId: 'x',
        timestamp: 0,
        source: 'stdout',
        payload: null,
      }
      // Should not throw — buffered in memory
      await expect(store.appendRaw(event)).resolves.toBeUndefined()
    })
  })
})
