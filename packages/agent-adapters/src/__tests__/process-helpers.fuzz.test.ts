import { describe, expect, it } from 'vitest'

import { spawnAndStreamJsonl } from '../utils/process-helpers.js'

/**
 * This file previously held 32 `it()` blocks fuzzing a LOCAL `tryParseJson`
 * defined at line 15, with zero imports from `../utils/process-helpers.js`.
 * Its header admitted it: "Replicate the try/catch JSON.parse pattern from
 * process-helpers."
 *
 * That replication encoded the WRONG behaviour. The local helper hardcoded
 * "silently skip malformed lines", but `spawnAndStreamJsonl` takes a
 * `malformedLinePolicy: 'skip' | 'error'` and forwards it to
 * `runJsonlProcess` — and the real adapters (qwen-adapter.ts:212,
 * gemini-adapter.ts:283) default it to `'error'`, not `'skip'`. So the fuzz
 * suite could never reach the branch it claimed to fuzz, and would not have
 * noticed the policy changing.
 *
 * `runJsonlProcess` itself is covered directly in cli-runtime.test.ts. What
 * was missing — and is asserted below — is that the public
 * `spawnAndStreamJsonl` wrapper actually FORWARDS the policy rather than
 * swallowing it, for both values and for the default.
 */
async function collect(stream: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for await (const record of stream) out.push(record)
  return out
}

/** Emit a preamble line that is not JSON, then one valid JSONL record. */
const MALFORMED_THEN_VALID = `process.stdout.write('not-json\\n');process.stdout.write(JSON.stringify({ok:true})+'\\n')`

describe('spawnAndStreamJsonl — malformedLinePolicy forwarding', () => {
  it("skips malformed lines when the policy is 'skip'", async () => {
    const records = await collect(
      spawnAndStreamJsonl(process.execPath, ['-e', MALFORMED_THEN_VALID], {
        malformedLinePolicy: 'skip',
      }),
    )
    expect(records).toEqual([{ ok: true }])
  })

  it("throws on a malformed line when the policy is 'error'", async () => {
    await expect(
      collect(
        spawnAndStreamJsonl(process.execPath, ['-e', MALFORMED_THEN_VALID], {
          malformedLinePolicy: 'error',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'ADAPTER_EXECUTION_FAILED',
      context: expect.objectContaining({ classification: 'malformed_stream' }),
    })
  })

  it('defaults to skipping when no policy is supplied', async () => {
    const records = await collect(
      spawnAndStreamJsonl(process.execPath, ['-e', MALFORMED_THEN_VALID], {}),
    )
    expect(records).toEqual([{ ok: true }])
  })

  it("rejects a non-object JSON line under the 'error' policy", async () => {
    await expect(
      collect(
        spawnAndStreamJsonl(process.execPath, ['-e', `process.stdout.write('42\\n')`], {
          malformedLinePolicy: 'error',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_EXECUTION_FAILED' })
  })

  it('yields every well-formed record regardless of policy', async () => {
    const script = `process.stdout.write(JSON.stringify({n:1})+'\\n');process.stdout.write(JSON.stringify({n:2})+'\\n')`
    for (const policy of ['skip', 'error'] as const) {
      const records = await collect(
        spawnAndStreamJsonl(process.execPath, ['-e', script], { malformedLinePolicy: policy }),
      )
      expect(records).toEqual([{ n: 1 }, { n: 2 }])
    }
  })
})
