import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runJsonlProcess } from '../cli-runtime/run-jsonl-process.js'
import { createTemporaryProjection } from '../cli-runtime/temporary-projection.js'

async function collect(iterable: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []
  for await (const value of iterable) values.push(value)
  return values
}

describe('bounded CLI runtime', () => {
  it('rejects output overflow before yielding an oversized record', async () => {
    await expect(collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write(JSON.stringify({value:'x'.repeat(4096)})+'\\n')`],
      limits: { stdoutBytes: 128 },
    }))).rejects.toMatchObject({ code: 'ADAPTER_EXECUTION_FAILED', context: expect.objectContaining({ classification: 'output_overflow' }) })
  })

  it('classifies malformed JSONL in strict mode', async () => {
    await expect(collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('not-json\\n')`],
      malformedLinePolicy: 'error',
    }))).rejects.toMatchObject({ code: 'ADAPTER_EXECUTION_FAILED', context: expect.objectContaining({ classification: 'malformed_stream' }) })
  })

  it('bounds malformed-line diagnostic capture independently of stream progress', async () => {
    const diagnostics: string[] = []
    await collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('one\\ntwo\\nthree\\n')`],
      limits: { diagnostics: 2 },
    }, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message) }))
    expect(diagnostics).toEqual(['one', 'two'])
  })

  it('escalates an abort when a child ignores SIGTERM', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 80)
    await expect(collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],
      signal: controller.signal,
      terminationGraceMs: 20,
    }))).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
  })

  it('validates working directories before spawning', async () => {
    await expect(collect(runJsonlProcess({ command: process.execPath, args: [], cwd: '/definitely/missing/dzupagent-cwd' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('temporary projection', () => {
  it('creates private execution-local files and cleans them idempotently', async () => {
    const projection = await createTemporaryProjection('dzupagent-test-', {
      config: { path: 'nested/config.json', content: '{"ok":true}' },
    })
    expect(await readFile(projection.paths['config']!, 'utf8')).toBe('{"ok":true}')
    await projection.cleanup()
    await projection.cleanup()
    await expect(access(projection.root)).rejects.toBeDefined()
  })

  it('rejects projection path traversal', async () => {
    await expect(createTemporaryProjection('dzupagent-test-', {
      escape: { path: '../escape', content: 'no' },
    })).rejects.toThrow('contained')
  })

  it('rejects Windows absolute paths on every host platform', async () => {
    await expect(createTemporaryProjection('dzupagent-test-', {
      escape: { path: 'C:\\Users\\escape.json', content: 'no' },
    })).rejects.toThrow('relative')
  })
})
