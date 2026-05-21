import { describe, expect, it } from 'vitest'
import { createEventBus, ForgeError } from '@dzupagent/core/events'
import { IntentRouter, PipelineDefinitionSchema } from '@dzupagent/core/orchestration'
import { Semaphore } from '@dzupagent/core/utils'

describe('core public subpath resolution', () => {
  it('resolves the core subpaths used by adapter packages', () => {
    expect(typeof createEventBus).toBe('function')
    expect(typeof ForgeError).toBe('function')
    expect(typeof IntentRouter).toBe('function')
    expect(PipelineDefinitionSchema).toBeDefined()
    expect(typeof Semaphore).toBe('function')
  })
})
