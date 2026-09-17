import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCliAdapter } from '../claude/claude-cli-adapter.js'
import type { AgentInput, AgentStreamEvent } from '../types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const entrypoints = [
  ['execute', (adapter: ClaudeCliAdapter, input: AgentInput) => adapter.execute(input)],
  ['executeWithRaw', (adapter: ClaudeCliAdapter, input: AgentInput) => adapter.executeWithRaw(input)],
  ['resumeSession', (adapter: ClaudeCliAdapter, input: AgentInput) => adapter.resumeSession('native-session', input)],
] as const

const outcomes = [
  { label: 'preserves explicit success', providerFields: { is_error: false }, expectedFields: { isError: false } },
  { label: 'preserves explicit failure', providerFields: { is_error: true }, expectedFields: { isError: true } },
  { label: 'keeps a missing outcome absent', providerFields: {}, expectedFields: {} },
  { label: 'does not coerce a string outcome to success', providerFields: { is_error: 'false' }, expectedFields: {} },
  { label: 'does not coerce a null outcome to success', providerFields: { is_error: null }, expectedFields: {} },
]

describe.each(entrypoints)('Claude CLI tool-result transport through %s', (entrypoint, run) => {
  it.each(outcomes)('$label', async ({ providerFields, expectedFields }) => {
    const root = await mkdtemp(join(tmpdir(), 'claude-tool-outcome-'))
    roots.push(root)
    const cliPath = join(root, 'fixture-cli.cjs')
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: [{ type: 'text', text: 'tool output' }],
      ...providerFields,
    }
    const records = [
      { type: 'system', subtype: 'init', session_id: 'native-session' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'fixture.txt' } }] } },
      { type: 'user', message: { content: [toolResult] } },
      // Overall completion cannot establish the outcome of an individual tool.
      { type: 'result', subtype: 'success', session_id: 'native-session', result: 'finished' },
    ]
    await writeFile(cliPath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(records.map((record) => JSON.stringify(record)).join('\n') + '\n')})\n`, { mode: 0o700 })

    const adapter = new ClaudeCliAdapter({ cliPath, timeoutMs: 5_000 })
    const events: AgentStreamEvent[] = []
    for await (const event of run(adapter, {
      prompt: 'inspect fixture',
      workingDirectory: root,
      correlationId: 'outcome-correlation',
    })) events.push(event)

    expect(events.filter((event) => event.type === 'adapter:failed')).toEqual([])
    expect(events.filter((event) => event.type === 'adapter:tool_result')).toEqual([{
      type: 'adapter:tool_result',
      providerId: 'claude',
      toolName: 'Read',
      toolCallId: 'call-1',
      output: '[{"type":"text","text":"tool output"}]',
      durationMs: 0,
      timestamp: expect.any(Number),
      correlationId: 'outcome-correlation',
      ...expectedFields,
    }])
    const normalizedResult = events.find((event) => event.type === 'adapter:tool_result')!
    expect(Object.hasOwn(normalizedResult, 'isError')).toBe(Object.hasOwn(expectedFields, 'isError'))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed', sessionId: 'native-session', result: 'finished' })
    if (entrypoint === 'executeWithRaw') {
      expect(events.filter((event) => event.type === 'adapter:provider_raw').map((event) => event.rawEvent.payload))
        .toEqual(records)
    }
  })
})
