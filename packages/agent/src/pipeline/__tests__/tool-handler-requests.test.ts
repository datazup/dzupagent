import { describe, expect, it } from 'vitest'
import type { RuntimeToolHandlerInput } from '../pipeline-runtime-types.js'
import * as requests from '../tool-handlers/requests.js'

const input: RuntimeToolHandlerInput = { nodeId: 'node', node: { id: 'node', type: 'tool', toolName: 'fixture' }, arguments: { userPrompt: 'prompt', dispatchId: 'dispatch', provider: 'fixture', instructions: 'fixture', outputKey: 'output', command: 'fixture', output: 'output', source: 'source', schema: { type: 'object' }, providers: ['one', 'two'], goal: 'fixture', model: 'fixture', tools: false, input: { retained: true }, tags: ['tag'], specialists: ['worker'], commandAllowlist: ['fixture'], merge: 'all' }, context: { state: {}, previousResults: new Map(), idempotencyKey: 'stable' } }

describe('runtime tool request builders', () => {
  it('retain the execution context and the node arguments', () => {
    const prompt = requests.buildPromptRequest(input)
    expect(prompt.userPrompt).toBe('prompt')
    expect(prompt.tools).toBe(false)
    expect(prompt.context).toBe(input.context)
    expect(requests.buildWorkerDispatchRequest(input)).toMatchObject({ dispatchId: 'dispatch', commandAllowlist: ['fixture'], outputKey: 'output' })
    expect(requests.buildShellRunRequest(input)).toMatchObject({ command: 'fixture', output: 'output' })
    expect(requests.buildValidateSchemaRequest(input).schema).toEqual({ type: 'object' })
    expect(requests.buildAdapterRunRequest(input).tags).toEqual(['tag'])
    expect(requests.buildAdapterRaceRequest(input).providers).toEqual(['one', 'two'])
    expect(requests.buildAdapterParallelRequest(input).merge).toBe('all')
    expect(requests.buildAdapterSupervisorRequest(input).specialists).toEqual(['worker'])
  })

  it('validate required arguments before dispatch', () => {
    for (const build of [requests.buildPromptRequest, requests.buildWorkerDispatchRequest, requests.buildShellRunRequest, requests.buildValidateSchemaRequest, requests.buildAdapterRunRequest, requests.buildAdapterRaceRequest, requests.buildAdapterParallelRequest, requests.buildAdapterSupervisorRequest]) {
      expect(() => build({ ...input, arguments: {} })).toThrow(/must be/)
    }
  })
})
