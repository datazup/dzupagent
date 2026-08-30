import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  AdapterCapabilityProfile,
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentInput,
} from '../index.js'

describe('adapter execution-control contract', () => {
  it('locks the exact public requirement and admission shapes', () => {
    expectTypeOf<AdapterExecutionControlRequirement>().toEqualTypeOf<{
      readonly schema: 'dzupagent/adapter-execution-control-requirement/v1'
      readonly tools: { readonly mode: 'none' }
    }>()
    expectTypeOf<AdapterExecutionControlAdmission>().toEqualTypeOf<{
      readonly schema: 'dzupagent/adapter-execution-control-admission/v1'
      readonly status: 'admitted' | 'rejected'
      readonly providerId: AdapterProviderId
      readonly requirementSha256: string
      readonly tools: {
        readonly mode: 'none'
        readonly enforcement: 'provider-pre-dispatch' | 'unsupported'
      }
      readonly blockers: readonly string[]
      readonly effects: {
        readonly credentialReads: 0
        readonly networkAttempts: 0
        readonly providerDispatches: 0
        readonly providerSpendUsd: 0
      }
    }>()
  })

  it('exposes the exact zero-tool requirement and effect-free admission shapes', () => {
    const requirement: AdapterExecutionControlRequirement = {
      schema: 'dzupagent/adapter-execution-control-requirement/v1',
      tools: { mode: 'none' },
    }
    const admission: AdapterExecutionControlAdmission = {
      schema: 'dzupagent/adapter-execution-control-admission/v1',
      status: 'rejected',
      providerId: 'codex',
      requirementSha256: `sha256:${'a'.repeat(64)}`,
      tools: {
        mode: 'none',
        enforcement: 'unsupported',
      },
      blockers: ['zero_tool_dispatch_unsupported'],
      effects: {
        credentialReads: 0,
        networkAttempts: 0,
        providerDispatches: 0,
        providerSpendUsd: 0,
      },
    }

    expect(requirement).toEqual({
      schema: 'dzupagent/adapter-execution-control-requirement/v1',
      tools: { mode: 'none' },
    })
    expect(admission.effects).toEqual({
      credentialReads: 0,
      networkAttempts: 0,
      providerDispatches: 0,
      providerSpendUsd: 0,
    })
  })

  it('adds only optional execution-control members to legacy adapter contracts', () => {
    expectTypeOf<AgentInput['executionControlRequirement']>()
      .toEqualTypeOf<AdapterExecutionControlRequirement | undefined>()
    expectTypeOf<AdapterCapabilityProfile['supportsZeroToolDispatch']>()
      .toEqualTypeOf<boolean | undefined>()
    expectTypeOf<AgentCLIAdapter['admitExecutionControls']>()
      .toEqualTypeOf<
        | ((
          input: AgentInput,
          requirement: AdapterExecutionControlRequirement,
        ) => AdapterExecutionControlAdmission)
        | undefined
      >()
  })
})
