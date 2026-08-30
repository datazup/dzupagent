import { describe, expect, it } from 'vitest'

import { ForgeError } from '@dzupagent/core'

import type {
  AdapterCapabilityProfile,
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AgentCLIAdapter,
  AgentInput,
} from '../types.js'
import {
  admitAdapterExecutionControls,
  assertAdapterExecutionControlsAdmitted,
  buildExecutionControlAdmission,
  canonicalExecutionControlRequirement,
  executionControlRequirementSha256,
} from '../execution-control-admission.js'

const REQUIREMENT_BYTES = '{"schema":"dzupagent/adapter-execution-control-requirement/v1","tools":{"mode":"none"}}'
const REQUIREMENT_SHA256 = 'sha256:e367236e0d9802cbfd0f42190c9173d577c12ad4cbdd8b258721900eb78e5731'

const requirement = (): AdapterExecutionControlRequirement => ({
  schema: 'dzupagent/adapter-execution-control-requirement/v1',
  tools: { mode: 'none' },
})

const strictInput = (): AgentInput => ({
  prompt: 'bounded prompt',
  executionControlRequirement: requirement(),
  policyContext: {
    activePolicy: {
      toolPolicy: 'strict',
      allowedTools: [],
      blockedTools: [],
    },
    conformanceMode: 'strict',
  },
})

const capabilities = (
  supportsZeroToolDispatch: boolean | 'missing' = true,
): AdapterCapabilityProfile => ({
  supportsResume: false,
  supportsFork: false,
  supportsToolCalls: false,
  supportsStreaming: false,
  supportsCostUsage: false,
  ...(supportsZeroToolDispatch === 'missing'
    ? {}
    : { supportsZeroToolDispatch }),
})

const admittedEvidence = (): AdapterExecutionControlAdmission => ({
  schema: 'dzupagent/adapter-execution-control-admission/v1',
  status: 'admitted',
  providerId: 'codex',
  requirementSha256: REQUIREMENT_SHA256,
  tools: {
    mode: 'none',
    enforcement: 'provider-pre-dispatch',
  },
  blockers: [],
  effects: {
    credentialReads: 0,
    networkAttempts: 0,
    providerDispatches: 0,
    providerSpendUsd: 0,
  },
})

function adapterFixture(options: {
  profile?: AdapterCapabilityProfile
  getCapabilities?: () => AdapterCapabilityProfile
  admission?: (
    input: AgentInput,
    value: AdapterExecutionControlRequirement,
  ) => AdapterExecutionControlAdmission
  omitAdmission?: boolean
} = {}): {
  adapter: AgentCLIAdapter
  calls: { admission: number; execute: number; resume: number }
} {
  const calls = { admission: 0, execute: 0, resume: 0 }
  const adapter: AgentCLIAdapter = {
    providerId: 'codex',
    async *execute() {
      calls.execute += 1
    },
    async *resumeSession() {
      calls.resume += 1
    },
    interrupt() {},
    async healthCheck() {
      return {
        healthy: true,
        providerId: 'codex',
        sdkInstalled: true,
        cliAvailable: true,
      }
    },
    configure() {},
    getCapabilities: options.getCapabilities
      ?? (() => options.profile ?? capabilities()),
    ...(!options.omitAdmission
      ? {
          admitExecutionControls: (
            input: AgentInput,
            value: AdapterExecutionControlRequirement,
          ) => {
            calls.admission += 1
            return options.admission
              ? options.admission(input, value)
              : admittedEvidence()
          },
        }
      : {}),
  }

  return { adapter, calls }
}

function replaceAdmission(
  replacement: unknown,
): (input: AgentInput, value: AdapterExecutionControlRequirement) => AdapterExecutionControlAdmission {
  return () => replacement as AdapterExecutionControlAdmission
}

function enumerableAccessor(
  target: object,
  key: PropertyKey,
  value: unknown,
  onRead: () => void,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      onRead()
      return value
    },
  })
}

describe('execution-control admission', () => {
  it('canonicalizes only the exact zero-tool requirement and hashes its canonical UTF-8 bytes', () => {
    const canonical = canonicalExecutionControlRequirement(requirement())

    expect(JSON.stringify(canonical)).toBe(REQUIREMENT_BYTES)
    expect(executionControlRequirementSha256(canonical)).toBe(REQUIREMENT_SHA256)
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical.tools)).toBe(true)
  })

  it.each([
    ['an extra requirement key', {
      ...requirement(),
      extra: true,
    }],
    ['an extra requirement tools key', {
      ...requirement(),
      tools: { mode: 'none', extra: true },
    }],
    ['a malformed requirement schema', {
      ...requirement(),
      schema: 'dzupagent/adapter-execution-control-requirement/v2',
    }],
    ['a malformed requirement tools mode', {
      ...requirement(),
      tools: { mode: 'host-denied' },
    }],
    ['an array instead of a requirement', []],
    ['null instead of a requirement', null],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalExecutionControlRequirement(value)).toThrow()
  })

  it.each([
    ['requirement schema', () => {
      let reads = 0
      const value: Record<string, unknown> = { tools: { mode: 'none' } }
      enumerableAccessor(value, 'schema', requirement().schema, () => { reads += 1 })
      return { value, reads: () => reads }
    }],
    ['requirement tools', () => {
      let reads = 0
      const value: Record<string, unknown> = { schema: requirement().schema }
      enumerableAccessor(value, 'tools', { mode: 'none' }, () => { reads += 1 })
      return { value, reads: () => reads }
    }],
    ['requirement tools mode', () => {
      let reads = 0
      const tools: Record<string, unknown> = {}
      enumerableAccessor(tools, 'mode', 'none', () => { reads += 1 })
      const value = { schema: requirement().schema, tools }
      return { value, reads: () => reads }
    }],
  ])('rejects an accessor-backed %s without invoking its getter', (_label, makeValue) => {
    const hostile = makeValue()

    expect(() => canonicalExecutionControlRequirement(hostile.value)).toThrow()
    expect(hostile.reads()).toBe(0)
  })

  it('rejects non-canonical runtime requirements before calling the adapter method', () => {
    const { adapter, calls } = adapterFixture()
    const input = strictInput() as AgentInput & {
      executionControlRequirement: Record<string, unknown>
    }
    input.executionControlRequirement.extra = true

    const result = admitAdapterExecutionControls(adapter, input as AgentInput)

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_requirement_invalid'],
    })
    expect(calls).toEqual({ admission: 0, execute: 0, resume: 0 })
  })

  it.each([
    ['missing active policy', (input: AgentInput) => {
      input.policyContext = { conformanceMode: 'strict' }
    }],
    ['missing toolPolicy', (input: AgentInput) => {
      delete input.policyContext?.activePolicy?.toolPolicy
    }],
    ['conflicting toolPolicy', (input: AgentInput) => {
      if (input.policyContext?.activePolicy) {
        input.policyContext.activePolicy.toolPolicy = 'balanced'
      }
    }],
    ['missing allowedTools', (input: AgentInput) => {
      delete input.policyContext?.activePolicy?.allowedTools
    }],
    ['non-empty allowedTools', (input: AgentInput) => {
      if (input.policyContext?.activePolicy) {
        input.policyContext.activePolicy.allowedTools = ['read']
      }
    }],
    ['missing blockedTools', (input: AgentInput) => {
      delete input.policyContext?.activePolicy?.blockedTools
    }],
    ['non-empty blockedTools', (input: AgentInput) => {
      if (input.policyContext?.activePolicy) {
        input.policyContext.activePolicy.blockedTools = ['shell']
      }
    }],
    ['missing conformanceMode', (input: AgentInput) => {
      delete input.policyContext?.conformanceMode
    }],
    ['warn-only conformanceMode', (input: AgentInput) => {
      if (input.policyContext) input.policyContext.conformanceMode = 'warn-only'
    }],
  ])('rejects an opted-in input with %s', (_label, mutate) => {
    const input = strictInput()
    mutate(input)
    const { adapter, calls } = adapterFixture()

    const result = admitAdapterExecutionControls(adapter, input)

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_policy_inconsistent'],
    })
    expect(calls).toEqual({ admission: 0, execute: 0, resume: 0 })
  })

  it.each([
    ['executionControlRequirement', (input: AgentInput) => {
      const mutable = input as AgentInput & {
        executionControlRequirement: unknown
      }
      mutable.executionControlRequirement = {
        schema: requirement().schema,
        tools: { mode: 'provider-default' },
      }
    }, 'execution_control_requirement_changed_after_admission'],
    ['toolPolicy', (input: AgentInput) => {
      if (input.policyContext?.activePolicy) {
        input.policyContext.activePolicy.toolPolicy = 'balanced'
      }
    }, 'execution_control_policy_changed_after_admission'],
    ['allowedTools', (input: AgentInput) => {
      input.policyContext?.activePolicy?.allowedTools?.push('read')
    }, 'execution_control_policy_changed_after_admission'],
    ['blockedTools', (input: AgentInput) => {
      input.policyContext?.activePolicy?.blockedTools?.push('shell')
    }, 'execution_control_policy_changed_after_admission'],
    ['conformanceMode', (input: AgentInput) => {
      if (input.policyContext) input.policyContext.conformanceMode = 'warn-only'
    }, 'execution_control_policy_changed_after_admission'],
  ])('rejects post-call mutation of %s', (_label, mutate, blocker) => {
    const input = strictInput()
    const { adapter, calls } = adapterFixture({
      admission: (received) => {
        mutate(received)
        return admittedEvidence()
      },
    })

    const result = admitAdapterExecutionControls(adapter, input)

    expect(result).toMatchObject({ status: 'rejected', blockers: [blocker] })
    expect(calls).toEqual({ admission: 1, execute: 0, resume: 0 })
  })

  it.each([
    ['false', capabilities(false)],
    ['missing', capabilities('missing')],
  ])('rejects a %s supportsZeroToolDispatch capability', (_label, profile) => {
    const { adapter, calls } = adapterFixture({ profile })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['zero_tool_dispatch_capability_missing'],
    })
    expect(calls).toEqual({ admission: 0, execute: 0, resume: 0 })
  })

  it('rejects a throwing capability profile without leaking the exception', () => {
    const { adapter, calls } = adapterFixture({
      getCapabilities: () => {
        throw new Error('do not leak this message')
      },
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['zero_tool_dispatch_capability_invalid'],
    })
    expect(JSON.stringify(result)).not.toContain('do not leak this message')
    expect(calls).toEqual({ admission: 0, execute: 0, resume: 0 })
  })

  it('rejects a missing admission method', () => {
    const { adapter, calls } = adapterFixture({ omitAdmission: true })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_method_missing'],
    })
    expect(calls).toEqual({ admission: 0, execute: 0, resume: 0 })
  })

  it('rejects a throwing admission method without leaking the exception', () => {
    const { adapter, calls } = adapterFixture({
      admission: () => {
        throw new Error('do not leak admission details')
      },
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_method_threw'],
    })
    expect(JSON.stringify(result)).not.toContain('do not leak admission details')
    expect(calls).toEqual({ admission: 1, execute: 0, resume: 0 })
  })

  it.each([
    ['an extra admission key', {
      ...admittedEvidence(),
      extra: true,
    }],
    ['an extra admission tools key', {
      ...admittedEvidence(),
      tools: {
        ...admittedEvidence().tools,
        extra: true,
      },
    }],
    ['an extra effects key', {
      ...admittedEvidence(),
      effects: {
        ...admittedEvidence().effects,
        fileReads: 0,
      },
    }],
    ['a malformed admission schema', {
      ...admittedEvidence(),
      schema: 'dzupagent/adapter-execution-control-admission/v2',
    }],
    ['a malformed admission status', {
      ...admittedEvidence(),
      status: 'approved',
    }],
    ['a malformed blockers collection', {
      ...admittedEvidence(),
      blockers: 'none',
    }],
    ['a non-object admission', null],
  ])('rejects returned evidence with %s', (_label, evidence) => {
    const { adapter, calls } = adapterFixture({
      admission: replaceAdmission(evidence),
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_malformed'],
    })
    expect(calls).toEqual({ admission: 1, execute: 0, resume: 0 })
  })

  it.each([
    ['admission schema', () => {
      let reads = 0
      const value = admittedEvidence() as unknown as Record<string, unknown>
      enumerableAccessor(value, 'schema', admittedEvidence().schema, () => { reads += 1 })
      return { value, reads: () => reads }
    }],
    ['admission tools', () => {
      let reads = 0
      const value = admittedEvidence() as unknown as Record<string, unknown>
      enumerableAccessor(value, 'tools', admittedEvidence().tools, () => { reads += 1 })
      return { value, reads: () => reads }
    }],
    ['admission tools enforcement', () => {
      let reads = 0
      const tools: Record<string, unknown> = { mode: 'none' }
      enumerableAccessor(tools, 'enforcement', 'provider-pre-dispatch', () => { reads += 1 })
      const value = { ...admittedEvidence(), tools }
      return { value, reads: () => reads }
    }],
    ['admission effects', () => {
      let reads = 0
      const value = admittedEvidence() as unknown as Record<string, unknown>
      enumerableAccessor(value, 'effects', admittedEvidence().effects, () => { reads += 1 })
      return { value, reads: () => reads }
    }],
    ['admission effects credentialReads', () => {
      let reads = 0
      const effects: Record<string, unknown> = {
        networkAttempts: 0,
        providerDispatches: 0,
        providerSpendUsd: 0,
      }
      enumerableAccessor(effects, 'credentialReads', 0, () => { reads += 1 })
      const value = { ...admittedEvidence(), effects }
      return { value, reads: () => reads }
    }],
  ])('rejects an accessor-backed %s without invoking its getter', (_label, makeValue) => {
    const hostile = makeValue()
    const { adapter, calls } = adapterFixture({
      admission: replaceAdmission(hostile.value),
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_malformed'],
    })
    expect(hostile.reads()).toBe(0)
    expect(calls).toEqual({ admission: 1, execute: 0, resume: 0 })
  })

  it.each([
    ['an overridden own map property', () => {
      const blockers: string[] = []
      Object.defineProperty(blockers, 'map', {
        configurable: true,
        value: () => [],
      })
      return blockers
    }],
    ['a sparse element', () => new Array<string>(1)],
    ['an extra string property', () => {
      const blockers: string[] = []
      Object.defineProperty(blockers, 'extra', {
        configurable: true,
        enumerable: true,
        value: true,
      })
      return blockers
    }],
    ['an extra symbol property', () => {
      const blockers: string[] = []
      Object.defineProperty(blockers, Symbol('extra'), {
        configurable: true,
        value: true,
      })
      return blockers
    }],
  ])('rejects a blockers array with %s', (_label, makeBlockers) => {
    const evidence = {
      ...admittedEvidence(),
      blockers: makeBlockers(),
    }
    const { adapter, calls } = adapterFixture({
      admission: replaceAdmission(evidence),
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_malformed'],
    })
    expect(calls).toEqual({ admission: 1, execute: 0, resume: 0 })
  })

  it('rejects an accessor-backed blockers element without invoking its getter', () => {
    let reads = 0
    const blockers: string[] = []
    enumerableAccessor(blockers, '0', 'manufactured_admission', () => { reads += 1 })
    const evidence = { ...admittedEvidence(), blockers }
    const { adapter, calls } = adapterFixture({
      admission: replaceAdmission(evidence),
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_malformed'],
    })
    expect(reads).toBe(0)
    expect(calls).toEqual({ admission: 1, execute: 0, resume: 0 })
  })

  it('rejects returned evidence for a different provider', () => {
    const evidence = { ...admittedEvidence(), providerId: 'openai' }
    const { adapter } = adapterFixture({ admission: replaceAdmission(evidence) })

    expect(admitAdapterExecutionControls(adapter, strictInput())).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_provider_mismatch'],
    })
  })

  it.each([
    ['a digest without the sha256 prefix', REQUIREMENT_SHA256.slice('sha256:'.length)],
    ['an uppercase digest', REQUIREMENT_SHA256.toUpperCase()],
    ['a digest for different bytes', `sha256:${'0'.repeat(64)}`],
  ])('rejects returned evidence with %s', (_label, requirementSha256) => {
    const evidence = { ...admittedEvidence(), requirementSha256 }
    const { adapter } = adapterFixture({ admission: replaceAdmission(evidence) })

    expect(admitAdapterExecutionControls(adapter, strictInput())).toMatchObject({
      status: 'rejected',
      blockers: [requirementSha256 === `sha256:${'0'.repeat(64)}`
        ? 'execution_control_admission_digest_mismatch'
        : 'execution_control_admission_digest_invalid'],
    })
  })

  it.each([
    ['blockers on an admitted result', {
      ...admittedEvidence(),
      blockers: ['unexpected_blocker'],
    }],
    ['unsupported enforcement on an admitted result', {
      ...admittedEvidence(),
      tools: { mode: 'none', enforcement: 'unsupported' },
    }],
    ['a credential read', {
      ...admittedEvidence(),
      effects: { ...admittedEvidence().effects, credentialReads: 1 },
    }],
    ['a network attempt', {
      ...admittedEvidence(),
      effects: { ...admittedEvidence().effects, networkAttempts: 1 },
    }],
    ['a provider dispatch', {
      ...admittedEvidence(),
      effects: { ...admittedEvidence().effects, providerDispatches: 1 },
    }],
    ['provider spend', {
      ...admittedEvidence(),
      effects: { ...admittedEvidence().effects, providerSpendUsd: 0.01 },
    }],
  ])('rejects %s', (_label, evidence) => {
    const { adapter } = adapterFixture({ admission: replaceAdmission(evidence) })

    expect(admitAdapterExecutionControls(adapter, strictInput())).toMatchObject({
      status: 'rejected',
      blockers: ['execution_control_admission_malformed'],
    })
  })

  it('returns a valid adapter rejection with stable bounded blocker codes', () => {
    const returned = buildExecutionControlAdmission({
      providerId: 'codex',
      requirement: requirement(),
      status: 'rejected',
      enforcement: 'unsupported',
      blockers: ['zero_tool_dispatch_unsupported', 'backend_not_empty', 'zero_tool_dispatch_unsupported'],
    })
    const { adapter } = adapterFixture({
      admission: () => returned,
    })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).toEqual({
      schema: 'dzupagent/adapter-execution-control-admission/v1',
      status: 'rejected',
      providerId: 'codex',
      requirementSha256: REQUIREMENT_SHA256,
      tools: { mode: 'none', enforcement: 'unsupported' },
      blockers: ['backend_not_empty', 'zero_tool_dispatch_unsupported'],
      effects: {
        credentialReads: 0,
        networkAttempts: 0,
        providerDispatches: 0,
        providerSpendUsd: 0,
      },
    })
    expect(() => buildExecutionControlAdmission({
      providerId: 'codex',
      requirement: requirement(),
      status: 'rejected',
      enforcement: 'unsupported',
      blockers: Array.from({ length: 17 }, (_, index) => `blocker_${index}`),
    })).toThrow()
    expect(() => buildExecutionControlAdmission({
      providerId: 'codex',
      requirement: requirement(),
      status: 'rejected',
      enforcement: 'unsupported',
      blockers: [`b${'x'.repeat(64)}`],
    })).toThrow()
  })

  it('builds deeply frozen evidence from ordinary frozen requirement and blocker data', () => {
    const frozenRequirement: AdapterExecutionControlRequirement = Object.freeze({
      schema: 'dzupagent/adapter-execution-control-requirement/v1',
      tools: Object.freeze({ mode: 'none' }),
    })
    const frozenBlockers = Object.freeze(['zero_tool_dispatch_unsupported'])

    const result = buildExecutionControlAdmission({
      providerId: 'codex',
      requirement: frozenRequirement,
      status: 'rejected',
      enforcement: 'unsupported',
      blockers: frozenBlockers,
    })

    expect(result).toEqual({
      schema: 'dzupagent/adapter-execution-control-admission/v1',
      status: 'rejected',
      providerId: 'codex',
      requirementSha256: REQUIREMENT_SHA256,
      tools: { mode: 'none', enforcement: 'unsupported' },
      blockers: ['zero_tool_dispatch_unsupported'],
      effects: {
        credentialReads: 0,
        networkAttempts: 0,
        providerDispatches: 0,
        providerSpendUsd: 0,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.blockers)).toBe(true)
  })

  it('returns stable canonical admitted evidence without executing the adapter', () => {
    const { adapter, calls } = adapterFixture()
    const input = strictInput()

    const first = admitAdapterExecutionControls(adapter, input)
    const second = admitAdapterExecutionControls(adapter, structuredClone(input))

    expect(first).toEqual(second)
    expect(first).toEqual(admittedEvidence())
    expect(first?.requirementSha256).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(calls).toEqual({ admission: 2, execute: 0, resume: 0 })
  })

  it('deep-freezes rebuilt admission evidence instead of trusting adapter-owned objects', () => {
    const returned = admittedEvidence()
    const { adapter } = adapterFixture({ admission: () => returned })

    const result = admitAdapterExecutionControls(adapter, strictInput())

    expect(result).not.toBe(returned)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result?.tools)).toBe(true)
    expect(Object.isFrozen(result?.blockers)).toBe(true)
    expect(Object.isFrozen(result?.effects)).toBe(true)
  })

  it('bypasses legacy inputs without manufacturing admitted evidence', () => {
    const { adapter, calls } = adapterFixture()
    const input: AgentInput = { prompt: 'legacy prompt' }

    expect(admitAdapterExecutionControls(adapter, input)).toBeUndefined()
    expect(assertAdapterExecutionControlsAdmitted(adapter, input)).toBeUndefined()
    expect(calls).toEqual({ admission: 0, execute: 0, resume: 0 })
  })

  it('returns admitted evidence from the assertion helper for an opted-in input', () => {
    const { adapter } = adapterFixture()

    expect(assertAdapterExecutionControlsAdmitted(adapter, strictInput())).toEqual(
      admittedEvidence(),
    )
  })

  it('throws a non-recoverable CAPABILITY_DENIED ForgeError only for opted-in rejection', () => {
    const { adapter } = adapterFixture({ omitAdmission: true })

    let thrown: unknown
    try {
      assertAdapterExecutionControlsAdmitted(adapter, strictInput())
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ForgeError)
    expect(thrown).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
    })
  })
})
