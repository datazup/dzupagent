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
    const script = `
      process.stdout.write('{"a":1}\\\\n{"b":2}\\\\n');
      process.stdout.write('{"c":3}\\\\n');
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
    )
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('skips invalid JSON lines gracefully', async () => {
    const script = `
      process.stdout.write('not json\\\\n{"a":1}\\\\ngarbage\\\\n')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips empty lines', async () => {
    const script = `
      process.stdout.write('\\\\n\\\\n{"a":1}\\\\n\\\\n')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips JSON arrays (only accepts objects)', async () => {
    const script = `
      process.stdout.write('[1,2,3]\\\\n{"a":1}\\\\n')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips JSON null and primitives', async () => {
    const script = `
      process.stdout.write('null\\\\n42\\\\n"string"\\\\n{"ok":true}\\\\n')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
    )
    expect(records).toEqual([{ ok: true }])
  })

  it('parses trailing partial buffer without newline', async () => {
    const script = `
      process.stdout.write('{"a":1}')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('skips malformed trailing partial buffer', async () => {
    const script = `
      process.stdout.write('{"a":1}\\\\n{"incomplete":')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
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
    const script = `
      process.stdout.write(JSON.stringify({ value: process.env.TEST_VAR }) + '\\\\n')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script], {
        env: { ...process.env, TEST_VAR: 'custom-value' },
      }),
    )
    expect(records).toEqual([{ value: 'custom-value' }])
  })

  it('handles timeoutMs=0 as no-timeout', async () => {
    const script = `process.stdout.write('{"a":1}\\\\n')`
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script], { timeoutMs: 0 }),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('respects undefined timeoutMs', async () => {
    const script = `process.stdout.write('{"a":1}\\\\n')`
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script], { timeoutMs: undefined }),
    )
    expect(records).toEqual([{ a: 1 }])
  })

  it('supports backpressure with multiple records', async () => {
    const script = `
      process.stdout.write('{"a":1}\\\\n{"b":2}\\\\n{"c":3}\\\\n')
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script], { backpressure: true }),
    )
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('handles JSON split across multiple chunks', async () => {
    // Write a single JSON with explicit delay so it straddles chunk boundaries
    const script = `
      process.stdout.write('{"key":"');
      setTimeout(() => {
        process.stdout.write('value"}\\\\n')
      }, 20);
    `
    const records = await collectRecords(
      spawnAndStreamJsonl('node', ['-e', script]),
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
