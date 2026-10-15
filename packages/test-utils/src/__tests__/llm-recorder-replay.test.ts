import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HumanMessage } from '@langchain/core/messages'
import { LLMRecorder } from '../llm-recorder.js'
import { MockChatModel } from '../mock-model.js'

test('local model recording replays exact fixtures without dispatching the model again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recording-regression-'))
  try {
    const messages = [new HumanMessage('fixture prompt')]
    const model = new MockChatModel(['fixture output'])
    const record = new LLMRecorder({ fixtureDir: root, mode: 'record' })
    expect((await record.wrap(model).invoke(messages)).content).toBe('fixture output')
    expect(record.hasFixture(messages)).toBe(true)
    expect(record.listFixtures()).toHaveLength(1)
    const replay = new LLMRecorder({ fixtureDir: root, mode: 'replay' })
    expect((await replay.wrap(model).invoke(messages)).content).toBe('fixture output')
    expect((await replay.replay(record.hashMessages(messages)).invoke(messages)).content).toBe('fixture output')
    expect(new LLMRecorder({ fixtureDir: root, mode: 'passthrough' }).wrap(model)).toBe(model)
    await expect(replay.wrap(model).invoke([new HumanMessage('missing')])).rejects.toThrow(/fixture not found/)
    expect(new LLMRecorder({ fixtureDir: join(root, 'missing'), mode: 'replay', hashInput: () => 'custom' }).listFixtures()).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
