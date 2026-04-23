import { describe, it, expect } from 'vitest'

import { spawnAndStreamJsonl } from '../utils/process-helpers.js'

async function collectRecords(
  gen: AsyncGenerator<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = []
  for await (const record of gen) {
    records.push(record)
  }
  return records
}

describe('spawnAndStreamJsonl', () => {
  it('throws AGENT_ABORTED when signal is pre-aborted even with timeout configured', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      collectRecords(
        spawnAndStreamJsonl('node', ['-e', 'setInterval(() => {}, 1000)'], {
          signal: controller.signal,
          timeoutMs: 50,
        }),
      ),
    ).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
  })

  it('throws AGENT_ABORTED when aborted during execution', async () => {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 20)

    await expect(
      collectRecords(
        spawnAndStreamJsonl('node', ['-e', 'setInterval(() => {}, 1000)'], {
          signal: controller.signal,
          timeoutMs: 2_000,
        }),
      ),
    ).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
  })

  it('accepts backpressure option without error', async () => {
    const script = `process.stdout.write(JSON.stringify({ a: 1 }) + '\\\\n')`
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script], { backpressure: true }),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('throws ADAPTER_TIMEOUT on timeout when not aborted', async () => {
    await expect(
      collectRecords(
        spawnAndStreamJsonl('node', ['-e', 'setInterval(() => {}, 1000)'], {
          timeoutMs: 50,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_TIMEOUT' })
  })
})
