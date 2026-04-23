import { describe, expect, it } from 'vitest'
import type {
  ExecutionRun,
  ExecutionRunStatus,
  PromptRecord,
  PromptType,
} from '../index.js'

describe('runtime-contracts execution seam', () => {
  it('keeps execution run records constructable', () => {
    const run: ExecutionRun = {
      id: 'r-1',
      taskId: 't-1',
      workflowRunId: 'w-1',
      providerId: 'openai',
      status: 'queued' satisfies ExecutionRunStatus,
      input: 'test prompt',
      startedAt: Date.now(),
    }

    expect(run.id).toBe('r-1')
    expect(run.status).toBe('queued')
  })

  it('keeps prompt records aligned with prompt type contracts', () => {
    const prompt: PromptRecord = {
      id: 'p-1',
      executionRunId: 'r-1',
      promptType: 'expanded' satisfies PromptType,
      rawPrompt: 'Summarize the diff',
      resolvedPrompt: 'Summarize the diff and include risks',
      tokenEstimate: 42,
      hashSha256: 'abc123',
      createdAt: Date.now(),
    }

    expect(prompt.promptType).toBe('expanded')
    expect(prompt.tokenEstimate).toBe(42)
  })
})
