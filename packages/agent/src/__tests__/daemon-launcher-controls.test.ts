import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { launchDaemon } from '../agent/daemon-launcher.js'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { ConcreteRunHandle } from '../agent/run-handle.js'
import {
  COOPERATIVE_RUN_HANDLE_CONTROL_CAPABILITIES,
  LEGACY_RUN_HANDLE_CONTROL_CAPABILITIES,
  type ControlAcknowledgement,
  type RunHandle,
} from '../agent/run-handle-types.js'
import type { GenerateResult } from '../agent/agent-types.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function result(content: string): GenerateResult {
  return {
    content,
    messages: [],
    usage: {
      totalInputTokens: 1,
      totalOutputTokens: 1,
      llmCalls: 1,
    },
    hitIterationLimit: false,
    stopReason: 'complete',
    toolStats: [],
  }
}

describe('launchDaemon legacy control characterization', () => {
  it('pause changes handle state but does not stop background completion', async () => {
    const generation = deferred<GenerateResult>()
    const generate = vi.fn(() => generation.promise)
    const handle = await launchDaemon({ agentId: 'agent-1', generate }, [], {
      runId: 'run-pause',
    })

    await handle.pause()
    expect(handle.currentStatus).toBe('paused')
    expect(handle.controlCapabilities.pause).toBe('handle-state-only')

    generation.resolve(result('completed while handle was paused'))

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      output: 'completed while handle was paused',
    })
    expect(generate).toHaveBeenCalledOnce()
  })

  it('cancel resolves the handle but does not abort background generation', async () => {
    const generation = deferred<GenerateResult>()
    let backgroundSettled = false
    const generate = vi.fn(async () => {
      const generated = await generation.promise
      backgroundSettled = true
      return generated
    })
    const handle = await launchDaemon({ agentId: 'agent-1', generate }, [], {
      runId: 'run-cancel',
    })

    await handle.cancel('operator request')
    await expect(handle.result()).resolves.toMatchObject({
      status: 'cancelled',
      error: 'operator request',
    })
    expect(handle.controlCapabilities.cancel).toBe('handle-state-only')

    generation.resolve(result('late output'))
    await vi.waitFor(() => expect(backgroundSettled).toBe(true))

    expect(handle.currentStatus).toBe('cancelled')
    expect(generate).toHaveBeenCalledOnce()
  })
})

// ─── Cooperative control through a real DzupAgent ────────────────────────────

/** Local fake chat model (same shape as dzip-agent-run-parity.test.ts). */
function createModel(options: { firstCallGate?: Promise<void>; onFirstCall?: () => void } = {}) {
  const responses = [
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-slow', name: 'slow', args: { step: 'one' } }],
    }),
    new AIMessage('done'),
  ]
  let calls = 0
  const model = {
    invoke: vi.fn(async (_messages: BaseMessage[]) => {
      const index = calls++
      if (index === 0) {
        options.onFirstCall?.()
        await options.firstCallGate
      }
      return responses[index] ?? new AIMessage('done')
    }),
    bindTools: vi.fn().mockReturnThis(),
  }
  return model as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

function createSlowTool(gate: Promise<string>, onStart?: () => void) {
  const invoke = vi.fn(async () => {
    onStart?.()
    return gate
  })
  const slow = tool(invoke, {
    name: 'slow',
    description: 'long-running test tool',
    schema: z.object({ step: z.string() }),
  })
  return { slow, invoke }
}

/** Typed view of the cooperative controls (the RunHandle interface stays `Promise<void>`). */
function controls(handle: RunHandle) {
  const concrete = handle as ConcreteRunHandle
  return {
    cancel: (reason?: string, options?: { timeoutMs?: number }) =>
      concrete.cancel(reason, options) as Promise<unknown> as Promise<ControlAcknowledgement>,
    pause: (options?: { timeoutMs?: number }) =>
      concrete.pause(options) as Promise<unknown> as Promise<ControlAcknowledgement>,
    journalTypes: async () =>
      (await concrete['journal'].getAll(handle.runId)).map((entry) => entry.type),
  }
}

async function launchCooperative(agent: DzupAgent, runId: string) {
  return agent.launch([new HumanMessage('run')], { runId, controlMode: 'cooperative' })
}

describe('launchDaemon cooperative control', () => {
  it('cancel during a long tool is observed after the tool and ends cancelled', async () => {
    const toolGate = deferred<string>()
    const toolStarted = deferred<void>()
    const model = createModel()
    const { slow, invoke } = createSlowTool(toolGate.promise, () => toolStarted.resolve())
    const agent = new DzupAgent({ id: 'coop-1', instructions: 't', model, tools: [slow] })
    const handle = await launchCooperative(agent, 'coop-cancel-tool')

    await toolStarted.promise
    const ack = controls(handle).cancel('operator stop')
    toolGate.resolve('late tool output')

    await expect(ack).resolves.toMatchObject({
      kind: 'cancel',
      state: 'observed-at-safe-point',
      safePoint: 'after-tool',
    })
    await expect(handle.result()).resolves.toMatchObject({
      status: 'cancelled',
      error: 'operator stop',
    })
    expect(model.invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(1)
    const types = await controls(handle).journalTypes()
    expect(types.filter((type) => type === 'run_cancelled')).toHaveLength(1)
    expect(types).not.toContain('run_completed')
  })

  it('cancel before the first model dispatch makes no model call', async () => {
    const model = createModel()
    const { slow, invoke } = createSlowTool(Promise.resolve('unused'))
    const agent = new DzupAgent({ id: 'coop-2', instructions: 't', model, tools: [slow] })
    const handle = await launchCooperative(agent, 'coop-cancel-early')

    const ack = await controls(handle).cancel()

    expect(ack).toMatchObject({
      kind: 'cancel',
      state: 'observed-at-safe-point',
      safePoint: 'before-model',
    })
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
    expect(model.invoke).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('pause holds at before-tool and resume continues the same iteration', async () => {
    const modelGate = deferred<void>()
    const modelStarted = deferred<void>()
    const model = createModel({
      firstCallGate: modelGate.promise,
      onFirstCall: () => modelStarted.resolve(),
    })
    const { slow, invoke } = createSlowTool(Promise.resolve('tool output'))
    const agent = new DzupAgent({ id: 'coop-3', instructions: 't', model, tools: [slow] })
    const handle = await launchCooperative(agent, 'coop-pause')

    await modelStarted.promise
    const pause = controls(handle).pause()
    modelGate.resolve()
    await expect(pause).resolves.toMatchObject({
      kind: 'pause',
      state: 'observed-at-safe-point',
      safePoint: 'before-tool',
    })
    expect(await handle.status()).toBe('paused')

    // Held: no tool dispatch and no further model call while paused.
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
    expect(invoke).not.toHaveBeenCalled()
    expect(model.invoke).toHaveBeenCalledTimes(1)

    await handle.resume()
    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      output: 'done',
    })
    // Same iteration count as an unpaused run: one tool turn, one final turn.
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(model.invoke).toHaveBeenCalledTimes(2)
    const types = await controls(handle).journalTypes()
    expect(types).toContain('run_paused')
    expect(types).toContain('run_resumed')
  })

  it('a cancel request alone is not terminal: timed-out keeps the run running', async () => {
    // The tool step outlasts the timeout: the tool returns, then its result
    // middleware (not raced against the signal) holds until released.
    const middlewareGate = deferred<void>()
    const middlewareEntered = deferred<void>()
    const model = createModel()
    const { slow } = createSlowTool(Promise.resolve('tool output'))
    const agent = new DzupAgent({
      id: 'coop-4',
      instructions: 't',
      model,
      tools: [slow],
      middleware: [
        {
          name: 'slow-result',
          wrapToolCall: async (_name, _input, result) => {
            middlewareEntered.resolve()
            await middlewareGate.promise
            return result
          },
        },
      ],
    })
    const handle = await launchCooperative(agent, 'coop-timeout')
    await middlewareEntered.promise

    const first = await controls(handle).cancel('stop', { timeoutMs: 10 })
    expect(first).toMatchObject({ kind: 'cancel', state: 'timed-out' })
    expect(first.safePoint).toBeUndefined()
    expect(await handle.status()).toBe('running')

    const second = controls(handle).cancel('stop again')
    middlewareGate.resolve()
    await expect(second).resolves.toMatchObject({
      state: 'observed-at-safe-point',
      safePoint: 'after-tool',
    })
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled', error: 'stop' })
    expect(model.invoke).toHaveBeenCalledTimes(1)
    const types = await controls(handle).journalTypes()
    expect(types.filter((type) => type === 'run_cancelled')).toHaveLength(1)
  })

  it('reports the cooperative marker only in cooperative mode', async () => {
    const agent = new DzupAgent({
      id: 'coop-5',
      instructions: 't',
      model: createModel(),
      tools: [createSlowTool(Promise.resolve('x')).slow],
    })
    const cooperative = await launchCooperative(agent, 'coop-marker')
    const legacy = await agent.launch([new HumanMessage('run')], { runId: 'legacy-marker' })

    expect(cooperative.controlCapabilities).toBe(COOPERATIVE_RUN_HANDLE_CONTROL_CAPABILITIES)
    expect(cooperative.controlCapabilities.backgroundExecution).toBe('cooperative-safe-points')
    expect(cooperative.controlCapabilities.crossProcessResume).toBe('inspection-only')
    expect(legacy.controlCapabilities).toBe(LEGACY_RUN_HANDLE_CONTROL_CAPABILITIES)
    await Promise.all([cooperative.result(), legacy.result()])
  })

  it('cancel while paused leaves waitForResume and ends cancelled at that safe point', async () => {
    const modelGate = deferred<void>()
    const modelStarted = deferred<void>()
    const model = createModel({
      firstCallGate: modelGate.promise,
      onFirstCall: () => modelStarted.resolve(),
    })
    const { slow, invoke } = createSlowTool(Promise.resolve('tool output'))
    const agent = new DzupAgent({ id: 'coop-6', instructions: 't', model, tools: [slow] })
    const handle = await launchCooperative(agent, 'coop-cancel-paused')

    await modelStarted.promise
    const pause = controls(handle).pause()
    modelGate.resolve()
    await expect(pause).resolves.toMatchObject({ safePoint: 'before-tool' })
    expect(await handle.status()).toBe('paused')

    await expect(controls(handle).cancel('stop while paused')).resolves.toMatchObject({
      kind: 'cancel',
      state: 'observed-at-safe-point',
      safePoint: 'before-tool',
    })
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
    expect(invoke).not.toHaveBeenCalled()
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })
})
