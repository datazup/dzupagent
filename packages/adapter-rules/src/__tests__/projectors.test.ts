import { describe, expect, it } from 'vitest'

import {
  projectClaudeConfig,
  projectCodexConfig,
  projectCrushConfig,
  projectGeminiConfig,
  projectGooseConfig,
  projectQwenConfig,
  projectProviderConfig,
} from '../projectors/index.js'
import type { CompileContext, RuntimePlan } from '../types.js'

function emptyPlan(overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return {
    providerId: 'claude',
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

describe('projectClaudeConfig', () => {
  it('returns empty patch when there are no approval flags', () => {
    const patch = projectClaudeConfig(emptyPlan(), { providerId: 'claude' })
    expect(patch).toEqual({})
  })

  it('returns permissions.additionalPermissions when approval flags are present', () => {
    const patch = projectClaudeConfig(
      emptyPlan({ auditFlags: ['approval:bash', 'approval:network'] }),
      { providerId: 'claude' },
    )
    expect(patch).toEqual({
      permissions: { additionalPermissions: ['approval:bash', 'approval:network'] },
    })
  })
})

describe('projectCodexConfig', () => {
  it('returns empty patch when there are no approval flags', () => {
    const patch = projectCodexConfig(emptyPlan(), { providerId: 'codex' })
    expect(patch).toEqual({})
  })

  it('returns approvalPolicy: on-failure when approval flags are present', () => {
    const patch = projectCodexConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'codex' },
    )
    expect(patch).toEqual({ approvalPolicy: 'on-failure' })
  })
})

describe('projectGeminiConfig', () => {
  it('returns empty patch when context has no model/apiKey and no approvals/denies', () => {
    const patch = projectGeminiConfig(emptyPlan(), { providerId: 'gemini' })
    expect(patch).toEqual({})
  })

  it('emits gemini_api_key and model from context', () => {
    const ctx: CompileContext = {
      providerId: 'gemini',
      apiKey: 'sk-gem-123',
      model: 'gemini-2.5-pro',
    }
    const patch = projectGeminiConfig(emptyPlan(), ctx)
    expect(patch).toEqual({
      gemini_api_key: 'sk-gem-123',
      model: 'gemini-2.5-pro',
    })
  })

  it('emits trust_tools: false and tool_config.require_confirmation when approvals present', () => {
    const patch = projectGeminiConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'gemini' },
    )
    expect(patch).toEqual({
      trust_tools: false,
      tool_config: {
        require_confirmation: true,
        approvals: ['approval:bash'],
      },
    })
  })

  it('emits tool_config.denied_paths when deniedPaths are present', () => {
    const patch = projectGeminiConfig(
      emptyPlan({ deniedPaths: ['.env', 'secrets/'] }),
      { providerId: 'gemini' },
    )
    expect(patch).toEqual({
      tool_config: { denied_paths: ['.env', 'secrets/'] },
    })
  })

  it('combines api key, model, approvals, and denied paths', () => {
    const ctx: CompileContext = {
      providerId: 'gemini',
      apiKey: 'sk-gem',
      model: 'gemini-2.5-flash',
    }
    const patch = projectGeminiConfig(
      emptyPlan({ auditFlags: ['approval:network'], deniedPaths: ['.env'] }),
      ctx,
    )
    expect(patch).toEqual({
      gemini_api_key: 'sk-gem',
      model: 'gemini-2.5-flash',
      trust_tools: false,
      tool_config: {
        require_confirmation: true,
        approvals: ['approval:network'],
        denied_paths: ['.env'],
      },
    })
  })
})

describe('projectQwenConfig', () => {
  it('returns empty patch when context has no fields and no approvals', () => {
    const patch = projectQwenConfig(emptyPlan(), { providerId: 'qwen' })
    expect(patch).toEqual({})
  })

  it('emits api_key, model, max_tokens from context', () => {
    const ctx: CompileContext = {
      providerId: 'qwen',
      apiKey: 'sk-qwen',
      model: 'qwen-max',
      maxTokens: 4096,
    }
    const patch = projectQwenConfig(emptyPlan(), ctx)
    expect(patch).toEqual({
      api_key: 'sk-qwen',
      model: 'qwen-max',
      max_tokens: 4096,
    })
  })

  it('emits approval_mode: require when approval flags are present', () => {
    const patch = projectQwenConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'qwen' },
    )
    expect(patch).toEqual({ approval_mode: 'require' })
  })

  it('combines context fields with approval_mode', () => {
    const ctx: CompileContext = {
      providerId: 'qwen',
      apiKey: 'sk',
      model: 'qwen-plus',
      maxTokens: 2048,
    }
    const patch = projectQwenConfig(
      emptyPlan({ auditFlags: ['approval:network'] }),
      ctx,
    )
    expect(patch).toEqual({
      api_key: 'sk',
      model: 'qwen-plus',
      max_tokens: 2048,
      approval_mode: 'require',
    })
  })
})

describe('projectGooseConfig', () => {
  it('returns empty patch when context has no fields and no approvals', () => {
    const patch = projectGooseConfig(emptyPlan(), { providerId: 'goose' })
    expect(patch).toEqual({})
  })

  it('emits GOOSE_MODEL and GOOSE_PROVIDER from context', () => {
    const ctx: CompileContext = {
      providerId: 'goose',
      model: 'claude-3-5-sonnet',
      providerName: 'anthropic',
    }
    const patch = projectGooseConfig(emptyPlan(), ctx)
    expect(patch).toEqual({
      GOOSE_MODEL: 'claude-3-5-sonnet',
      GOOSE_PROVIDER: 'anthropic',
    })
  })

  it('emits toolkits.require_confirmation: true when approval flags are present', () => {
    const patch = projectGooseConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'goose' },
    )
    expect(patch).toEqual({ toolkits: { require_confirmation: true } })
  })

  it('combines env-style keys with toolkits block', () => {
    const ctx: CompileContext = {
      providerId: 'goose',
      model: 'gpt-4o',
      providerName: 'openai',
    }
    const patch = projectGooseConfig(
      emptyPlan({ auditFlags: ['approval:network'] }),
      ctx,
    )
    expect(patch).toEqual({
      GOOSE_MODEL: 'gpt-4o',
      GOOSE_PROVIDER: 'openai',
      toolkits: { require_confirmation: true },
    })
  })
})

describe('projectCrushConfig', () => {
  it('returns empty patch when context has no fields and no approvals', () => {
    const patch = projectCrushConfig(emptyPlan(), { providerId: 'crush' })
    expect(patch).toEqual({})
  })

  it('emits crush_model and crush_api_key from context', () => {
    const ctx: CompileContext = {
      providerId: 'crush',
      model: 'crush-local',
      apiKey: 'sk-crush',
    }
    const patch = projectCrushConfig(emptyPlan(), ctx)
    expect(patch).toEqual({
      crush_model: 'crush-local',
      crush_api_key: 'sk-crush',
    })
  })

  it('emits safe_mode: true when approval flags are present', () => {
    const patch = projectCrushConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'crush' },
    )
    expect(patch).toEqual({ safe_mode: true })
  })

  it('combines model, api key, and safe_mode', () => {
    const ctx: CompileContext = {
      providerId: 'crush',
      model: 'crush-7b',
      apiKey: 'sk',
    }
    const patch = projectCrushConfig(
      emptyPlan({ auditFlags: ['approval:network'] }),
      ctx,
    )
    expect(patch).toEqual({
      crush_model: 'crush-7b',
      crush_api_key: 'sk',
      safe_mode: true,
    })
  })
})

describe('projectProviderConfig (dispatch)', () => {
  it('routes to Claude projector for providerId: claude', () => {
    const patch = projectProviderConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'claude' },
    )
    expect(patch).toEqual({
      permissions: { additionalPermissions: ['approval:bash'] },
    })
  })

  it('routes to Gemini projector for providerId: gemini-sdk as well', () => {
    const patch = projectProviderConfig(emptyPlan(), {
      providerId: 'gemini-sdk',
      model: 'gemini-2.5-pro',
    })
    expect(patch).toEqual({ model: 'gemini-2.5-pro' })
  })

  it('returns empty patch for providers without a registered projector', () => {
    const patch = projectProviderConfig(
      emptyPlan({ auditFlags: ['approval:bash'] }),
      { providerId: 'openrouter' },
    )
    expect(patch).toEqual({})
  })
})
