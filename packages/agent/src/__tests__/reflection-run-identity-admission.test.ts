import { describe, expect, it, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DzupAgentConfig } from '../agent/agent-types.js'
import type { OutputFilterContext } from '../agent/output-filter.js'
import { processGeneratedRun } from '../agent/run-engine-generate-process.js'

type ProcessParams = Parameters<typeof processGeneratedRun>[0]
type ProcessResult = Parameters<typeof processGeneratedRun>[1]

function makeResult(): ProcessResult {
  return {
    messages: [new AIMessage('done')],
    totalInputTokens: 2,
    totalOutputTokens: 1,
    llmCalls: 1,
    hitIterationLimit: false,
    stopReason: 'complete',
    toolStats: [],
  }
}

function makeParams(options: {
  optionsRunId?: string
  toolExecutionRunId?: string
  onReflectionComplete: NonNullable<DzupAgentConfig['onReflectionComplete']>
  onReflectionError?: NonNullable<DzupAgentConfig['onReflectionError']>
  captureFilterContext?: (context: OutputFilterContext) => void
}): ProcessParams {
  const config = {
    id: 'reflection-agent',
    instructions: 'test',
    model: 'gpt-4',
    ...(options.toolExecutionRunId !== undefined
      ? { toolExecution: { runId: options.toolExecutionRunId } }
      : {}),
    ...(options.captureFilterContext
      ? {
          outputFilters: [{
            name: 'capture-run-id',
            filter: (output: string, context: OutputFilterContext) => {
              options.captureFilterContext?.(context)
              return output
            },
          }],
        }
      : {}),
    onReflectionComplete: options.onReflectionComplete,
    ...(options.onReflectionError !== undefined
      ? { onReflectionError: options.onReflectionError }
      : {}),
  } as DzupAgentConfig

  return {
    agentId: 'reflection-agent',
    config,
    ...(options.optionsRunId !== undefined
      ? { options: { runId: options.optionsRunId } }
      : {}),
    runState: {
      maxIterations: 1,
      preparedMessages: [],
      tools: [],
      toolMap: new Map(),
      model: {} as BaseChatModel,
    },
    invokeModel: vi.fn(),
    transformToolResult: vi.fn(async (_name, _input, result: string) => result),
    maybeUpdateSummary: vi.fn(async () => {}),
  }
}

async function captureIdentities(options: {
  optionsRunId?: string
  toolExecutionRunId?: string
} = {}): Promise<{ filterRunId: string; reflectionRunId: string }> {
  let filterRunId = ''
  let reflectionRunId = ''
  const onReflectionComplete = vi.fn(async (summary) => {
    reflectionRunId = summary.runId
  })

  await processGeneratedRun(
    makeParams({
      ...options,
      onReflectionComplete,
      captureFilterContext: (context) => {
        filterRunId = context.runId
      },
    }),
    makeResult(),
    [],
  )

  expect(onReflectionComplete).toHaveBeenCalledTimes(1)
  return { filterRunId, reflectionRunId }
}

describe('post-run reflection identity admission', () => {
  it('uses GenerateOptions.runId exactly and shares it with output filtering', async () => {
    await expect(captureIdentities({ optionsRunId: 'run:options:exact' })).resolves.toEqual({
      filterRunId: 'run:options:exact',
      reflectionRunId: 'run:options:exact',
    })
  })

  it('gives GenerateOptions.runId precedence over toolExecution.runId', async () => {
    await expect(captureIdentities({
      optionsRunId: 'run:options:wins',
      toolExecutionRunId: 'run:tool:loses',
    })).resolves.toEqual({
      filterRunId: 'run:options:wins',
      reflectionRunId: 'run:options:wins',
    })
  })

  it('falls back to toolExecution.runId when GenerateOptions omits the ID', async () => {
    await expect(captureIdentities({ toolExecutionRunId: 'run:tool:fallback' })).resolves.toEqual({
      filterRunId: 'run:tool:fallback',
      reflectionRunId: 'run:tool:fallback',
    })
  })

  it('mints one non-empty identity and reuses it across both post-run consumers', async () => {
    const identities = await captureIdentities()

    expect(identities.reflectionRunId).not.toBe('')
    expect(identities.filterRunId).toBe(identities.reflectionRunId)
  })

  it('does not reuse fallback identities across distinct runs', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234_567)
    try {
      const first = await captureIdentities()
      const second = await captureIdentities()

      expect(first.reflectionRunId).not.toBe(second.reflectionRunId)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps callback rejection non-fatal and reports the exact error once', async () => {
    const failure = new Error('reflection sink unavailable')
    const onReflectionError = vi.fn()
    const onReflectionComplete = vi.fn(async () => {
      throw failure
    })

    await expect(processGeneratedRun(
      makeParams({ onReflectionComplete, onReflectionError }),
      makeResult(),
      [],
    )).resolves.toMatchObject({ content: 'done', stopReason: 'complete' })

    expect(onReflectionComplete).toHaveBeenCalledTimes(1)
    expect(onReflectionError).toHaveBeenCalledTimes(1)
    expect(onReflectionError).toHaveBeenCalledWith(failure)
  })
})
