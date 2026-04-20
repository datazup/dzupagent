import { describe, expect, it } from 'vitest'

import {
  projectCrushConfig,
  projectGooseConfig,
  projectProviderConfig,
} from '../projectors/index.js'
import type { CompileContext, RuntimePlan } from '../types.js'

function emptyPlan(overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return {
    providerId: 'goose',
    promptSections: [],
    requiredSkills: [],
    preferredAgent: undefined,
    providerConfigPatch: {},
    monitorSubscriptions: [],
    watchPaths: [],
    auditFlags: [],
    deniedPaths: [],
    alerts: [],
    ...overrides,
  }
}

describe('projectGooseConfig (dedicated)', () => {
  it('returns an empty patch when plan and context are empty', () => {
    const patch = projectGooseConfig(emptyPlan(), { providerId: 'goose' })
    expect(patch).toEqual({})
  })

  it('places model into provider.model when context.model is set', () => {
    const ctx: CompileContext = {
      providerId: 'goose',
      model: 'claude-3-5-sonnet',
    }
    const patch = projectGooseConfig(emptyPlan(), ctx)
    expect(patch['provider']).toEqual({ model: 'claude-3-5-sonnet' })
    expect(patch['GOOSE_MODEL']).toBe('claude-3-5-sonnet')
  })

  it('sets goose.mode: approve when approval rules are present', () => {
    const patch = projectGooseConfig(
      emptyPlan({ auditFlags: ['approval:bash', 'approval:network'] }),
      { providerId: 'goose' },
    )
    expect(patch['goose']).toEqual({ mode: 'approve' })
  })

  it('appends watchPaths as extensions entries', () => {
    const patch = projectGooseConfig(
      emptyPlan({ watchPaths: ['logs/', 'src/'] }),
      { providerId: 'goose' },
    )
    expect(patch['extensions']).toEqual([
      { type: 'watcher', path: 'logs/' },
      { type: 'watcher', path: 'src/' },
    ])
  })

  it('places apiKey into provider.api_key without approval mode when no approval flags', () => {
    const ctx: CompileContext = {
      providerId: 'goose',
      model: 'gpt-4o',
      apiKey: 'sk-oai',
    }
    const patch = projectGooseConfig(emptyPlan(), ctx)
    expect(patch['provider']).toEqual({
      model: 'gpt-4o',
      api_key: 'sk-oai',
    })
    expect(patch['goose']).toBeUndefined()
  })
})

describe('projectCrushConfig (dedicated)', () => {
  it('returns an empty patch when plan and context are empty', () => {
    const patch = projectCrushConfig(
      emptyPlan({ providerId: 'crush' }),
      { providerId: 'crush' },
    )
    expect(patch).toEqual({})
  })

  it('emits model and api_key from context', () => {
    const ctx: CompileContext = {
      providerId: 'crush',
      model: 'crush-7b',
      apiKey: 'sk-crush',
    }
    const patch = projectCrushConfig(emptyPlan({ providerId: 'crush' }), ctx)
    expect(patch).toEqual({
      model: 'crush-7b',
      api_key: 'sk-crush',
    })
  })

  it('sets permissionMode: ask when approval rules are present', () => {
    const patch = projectCrushConfig(
      emptyPlan({ providerId: 'crush', auditFlags: ['approval:bash'] }),
      { providerId: 'crush' },
    )
    expect(patch['permissionMode']).toBe('ask')
  })

  it('forwards mcp: prefixed monitor subscriptions into mcp.servers', () => {
    const patch = projectCrushConfig(
      emptyPlan({
        providerId: 'crush',
        monitorSubscriptions: ['mcp:filesystem', 'mcp:github', 'artifact:x'],
      }),
      { providerId: 'crush' },
    )
    expect(patch['mcp']).toEqual({ servers: ['filesystem', 'github'] })
  })
})

describe('projectProviderConfig dispatch for goose/crush', () => {
  it('routes goose providerId to the goose projector', () => {
    const patch = projectProviderConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'goose', model: 'gpt-4o' },
    )
    expect(patch).toEqual({
      provider: { model: 'gpt-4o' },
      GOOSE_MODEL: 'gpt-4o',
      goose: { mode: 'approve' },
    })
  })

  it('routes crush providerId to the crush projector', () => {
    const patch = projectProviderConfig(
      emptyPlan({ providerId: 'crush', auditFlags: ['approval:network'] }),
      { providerId: 'crush', model: 'crush-7b', apiKey: 'sk' },
    )
    expect(patch).toEqual({
      model: 'crush-7b',
      api_key: 'sk',
      permissionMode: 'ask',
    })
  })
})
