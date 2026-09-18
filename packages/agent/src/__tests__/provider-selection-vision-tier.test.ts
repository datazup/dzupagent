import { describe, expect, it, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ModelRegistry } from '@dzupagent/core'
import { resolveModel } from '../agent/provider-selection.js'

describe('vision tier resolution', () => {
  function setup() {
    const model = { invoke: vi.fn() } as unknown as BaseChatModel
    const registry = new ModelRegistry()
    registry.setFactory(() => model)
    registry.addProvider({ provider: 'openai', apiKey: 'test-only', models: {
      vision: { name: 'configured-image-model' },
      chat: { name: 'configured-chat-model' },
    } })
    return { registry, model }
  }

  it('resolves vision through the tier registry and retains provider failover metadata', () => {
    const { registry, model } = setup()
    const byName = vi.spyOn(registry, 'getModelByName')
    expect(resolveModel({ id: 'screenshot-analyzer', instructions: 'test', model: 'vision', registry }))
      .toEqual({ model, provider: 'openai', tier: 'vision' })
    expect(byName).not.toHaveBeenCalled()
  })

  it('preserves explicit model name lookup', () => {
    const { registry, model } = setup()
    expect(resolveModel({ id: 'explicit', instructions: 'test', model: 'configured-image-model', registry }))
      .toEqual({ model, provider: undefined, tier: undefined })
  })

  it('preserves existing chat tier lookup', () => {
    const { registry, model } = setup()
    expect(resolveModel({ id: 'chat', instructions: 'test', model: 'chat', registry }))
      .toEqual({ model, provider: 'openai', tier: 'chat' })
  })
})
