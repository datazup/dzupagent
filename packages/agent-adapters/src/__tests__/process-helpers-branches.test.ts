import { describe, it, expect } from 'vitest'

import {
  spawnAndStreamJsonl,
  isBinaryAvailable,
} from '../utils/process-helpers.js'

async function collectRecords(
  gen: AsyncGenerator<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = []
  for await (const record of gen) {
    records.push(record)
  }
  return records
}

function spawnBashJsonl(
  script: string,
  options?: Parameters<typeof spawnAndStreamJsonl>[2],
): AsyncGenerator<Record<string, unknown>> {
  return spawnAndStreamJsonl('bash', ['-lc', script], options)
}

describe('spawnAndStreamJsonl - branch coverage', () => {
  it('throws ADAPTER_SDK_NOT_INSTALLED when binary does not exist', async () => {
    await expect(
      collectRecords(
        spawnAndStreamJsonl('this-binary-should-not-exist-12345xyz', []),
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_SDK_NOT_INSTALLED' })
  })

  it('throws ADAPTER_EXECUTION_FAILED on non-zero exit code', async () => {
    await expect(
      collectRecords(
        spawnAndStreamJsonl('node', ['-e', 'process.exit(3)']),
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_EXECUTION_FAILED' })
  })

  it('handles multiple JSONL records across chunks', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' '{"a":1}' '{"b":2}' '{"c":3}'`),
    )
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('skips invalid JSON lines gracefully', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' 'not json' '{"a":1}' 'garbage'`),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips empty lines', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '\n\n%s\n\n' '{"a":1}'`),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips JSON arrays (only accepts objects)', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' '[1,2,3]' '{"a":1}'`),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips JSON null and primitives', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' 'null' '42' '"string"' '{"ok":true}'`),
    )
    expect(records).toEqual([{ ok: true }])
  })

  it('parses trailing partial buffer without newline', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s' '{"a":1}'`),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips malformed trailing partial buffer', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n%s' '{"a":1}' '{"incomplete":'`),
    )
    // Only the complete record is yielded
    expect(records).toEqual([{ a: 1 }])
  })

  it('handles process that exits cleanly with no output', async () => {
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', 'process.exit(0)']),
    )
    expect(records).toEqual([])
  })

  it('passes through spawn options like env', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '{"value":"%s"}\n' "$TEST_VAR"`, {
        env: { ...process.env, TEST_VAR: 'custom-value' },
      }),
    )
    expect(records).toEqual([{ value: 'custom-value' }])
  })

  it('handles timeoutMs=0 as no-timeout', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' '{"a":1}'`, { timeoutMs: 0 }),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('respects undefined timeoutMs', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' '{"a":1}'`, { timeoutMs: undefined }),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('supports backpressure with multiple records', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s\n' '{"a":1}' '{"b":2}' '{"c":3}'`, { backpressure: true }),
    )
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('handles JSON split across multiple chunks', async () => {
    const records = await collectRecords(
      spawnBashJsonl(`printf '%s' '{"key":"'; sleep 0.02; printf '%s\n' 'value"}'`),
    )
    expect(records).toEqual([{ key: 'value' }])
  })
})

describe('isBinaryAvailable', () => {
  it('returns true for a binary in PATH (node)', async () => {
    expect(await isBinaryAvailable('node')).toBe(true)
  })

  it('returns false for a non-existent binary', async () => {
    expect(await isBinaryAvailable('this-binary-does-not-exist-zzz9999')).toBe(false)
  })
})
