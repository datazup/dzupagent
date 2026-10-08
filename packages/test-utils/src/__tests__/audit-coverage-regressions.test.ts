import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { HumanMessage } from '@langchain/core/messages'
import { LLMRecorder } from '../llm-recorder.js'
import { MockChatModel } from '../mock-model.js'
import { createTestConfig, createTestAgent, waitForEvent } from '../test-helpers.js'
import { createExpressRouteHarness } from '../express-route-harness.js'

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

test('test config captures events and waiters unsubscribe on completion and timeout', async () => {
  const config = createTestConfig()
  expect(createTestAgent({ id: 'fixture', active: false }).active).toBe(false)
  expect(createTestAgent().modelTier).toBe('chat')
  const pending = waitForEvent(config.eventBus, 'agent:started', 100)
  config.eventBus.emit({ type: 'agent:started', agentId: 'fixture', runId: 'fixture' })
  expect((await pending).agentId).toBe('fixture')
  expect(config.events).toHaveLength(1)
  await expect(waitForEvent(config.eventBus, 'agent:started', 1)).rejects.toThrow(/Timeout/)
})

test('Express harness captures streamed headers and handles route errors', async () => {
  const harness = createExpressRouteHarness(() => {
    const app = express()
    app.get('/stream', (_req, res) => {
      res.writeHead(201, { 'X-Fixture': 'value' })
      res.setHeader('X-List', ['a', 'b'])
      res.write(Buffer.from('first'))
      res.end('last')
    })
    return app
  }, { originalUrl: url => '/prefix' + url })
  const response = await harness.dispatch({ method: 'GET', url: '/stream', headers: { 'X-Fixture': 'input' } })
  expect(response.statusCode).toBe(201)
  expect(response.getHeader('X-List')).toBe('a,b')
  expect(response.getHeaders()).toMatchObject({ 'x-fixture': 'value' })
  expect(response.writableEnded).toBe(true)
  expect(response.headersSent).toBe(true)
  expect(response.state.chunks).toEqual(['first', 'last'])
})
