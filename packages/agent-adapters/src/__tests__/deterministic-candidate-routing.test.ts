import { describe, expect, it, vi } from 'vitest'
import type {
  ExecutionRouteCandidate,
  ExecutionRoutePolicy,
  LocalModelCapabilityProfile,
} from '@dzupagent/runtime-contracts'

import type { AgentCLIAdapter, RoutingDecision } from '../types.js'
import {
  classifyRouteTransition,
  planCandidateRecovery,
  selectExecutionRoute,
} from '../registry/deterministic-candidate-selector.js'
import { materializeRoutingCandidates } from '../registry/candidate-materializer.js'
import { buildFallbackOrder } from '../registry/adapter-registry-helpers.js'

const DECIDED_AT = '2026-07-12T12:00:00.000Z'

function candidate(
  id: string,
  overrides: Partial<ExecutionRouteCandidate> = {},
): ExecutionRouteCandidate {
  return {
    id,
    provider: 'codex',
    backend: 'sdk',
    model: 'codex-1',
    profileRef: 'work',
    authSourceRef: 'codex-subscription',
    authAvailable: true,
    backendAvailable: true,
    modelAvailable: true,
    health: { status: 'healthy' },
    capabilities: ['tools', 'reasoning'],
    costClass: 'low',
    privacyClass: 'provider',
    locality: 'remote',
    accessClass: 'subscription',
    policyCompatible: true,
    ...overrides,
  }
}

function policy(
  candidates: readonly ExecutionRouteCandidate[],
  overrides: Partial<ExecutionRoutePolicy> = {},
): ExecutionRoutePolicy {
  return {
    id: 'route-policy',
    requestId: 'request-1',
    strategy: 'fixed',
    candidates,
    hardConstraints: [],
    preferenceOrder: candidates.map((item) => item.id),
    fallback: 'ordered-compatible',
    maxSelectionLatencyMs: 25,
    ...overrides,
  }
}

describe('deterministic candidate routing', () => {
  it('does not widen legacy fallback to unapproved healthy providers', () => {
    const decision = {
      provider: 'claude',
      reason: 'fixture',
      confidence: 1,
      fallbackProviders: ['codex', 'openai'],
    } satisfies RoutingDecision
    expect(buildFallbackOrder(decision, ['claude', 'codex', 'openai'])).toEqual(['claude'])
    expect(buildFallbackOrder(decision, ['claude', 'codex', 'openai'], ['codex'])).toEqual(['claude', 'codex'])
  })

  it('distinguishes Codex SDK and CLI identities with stable preference ordering', () => {
    const sdk = candidate('codex:sdk:work')
    const cli = candidate('codex:cli:work', { backend: 'cli' })
    const decision = selectExecutionRoute(policy([cli, sdk], {
      preferenceOrder: [sdk.id, cli.id],
    }), { decidedAt: DECIDED_AT })

    expect(decision.selectedCandidateId).toBe(sdk.id)
    expect(decision.fallbackCandidateIds).toEqual([cli.id])
    expect(decision.id).toBe('route-policy:request-1')
    expect(decision.decidedAt).toBe(DECIDED_AT)
  })

  it('uses candidate ID as a deterministic tie-break independent of input order', () => {
    const first = candidate('gemini:sdk', { provider: 'gemini-sdk', backend: 'sdk' })
    const second = candidate('gemini:cli', { provider: 'gemini', backend: 'cli' })
    const forward = selectExecutionRoute(policy([first, second], { preferenceOrder: [] }), { decidedAt: DECIDED_AT })
    const reverse = selectExecutionRoute(policy([second, first], { preferenceOrder: [] }), { decidedAt: DECIDED_AT })

    expect(forward.selectedCandidateId).toBe('gemini:cli')
    expect(reverse.selectedCandidateId).toBe('gemini:cli')
    expect(forward.eligibleCandidateIds).toEqual(reverse.eligibleCandidateIds)
  })

  it('represents Goose plus provider separately from direct Ollama', () => {
    const direct = candidate('ollama:direct:qwen3', {
      provider: 'ollama', backend: 'local-model', agentHost: undefined,
      model: 'qwen3', locality: 'local', accessClass: 'local', costClass: 'free', privacyClass: 'device',
    })
    const goose = candidate('goose:ollama:qwen3', {
      provider: 'ollama', backend: 'local-model', agentHost: 'goose',
      model: 'qwen3', locality: 'local', accessClass: 'local', costClass: 'free', privacyClass: 'device',
    })
    const decision = selectExecutionRoute(policy([goose, direct], { preferenceOrder: [direct.id, goose.id] }), { decidedAt: DECIDED_AT })

    expect(decision.selectedCandidateId).toBe(direct.id)
    expect(decision.fallbackCandidateIds).toEqual([goose.id])
  })

  it('returns stable rejection codes for auth, model, health, capability, and policy failures', () => {
    const candidates = [
      candidate('missing-auth', { authAvailable: false }),
      candidate('missing-model', { modelAvailable: false }),
      candidate('unhealthy', { health: { status: 'unhealthy', reason: 'probe failed' } }),
      candidate('missing-capability', { capabilities: [] }),
      candidate('policy-mismatch', { policyCompatible: false }),
    ]
    const decision = selectExecutionRoute(policy(candidates, {
      requirements: { capabilities: ['tools'], requireHealthy: true },
    }), { decidedAt: DECIDED_AT })

    expect(decision.selectedCandidateId).toBeNull()
    expect(Object.fromEntries(decision.rejected.map((item) => [item.candidateId, item.codes]))).toMatchObject({
      'missing-auth': ['AUTH_SOURCE_UNAVAILABLE'],
      'missing-model': ['MODEL_UNAVAILABLE'],
      unhealthy: ['HEALTH_CHECK_FAILED'],
      'missing-capability': ['CAPABILITY_MISSING'],
      'policy-mismatch': ['POLICY_INCOMPATIBLE'],
    })
  })

  it('blocks local-to-remote, identity, privacy, and higher-cost fallback without approval', () => {
    const local = candidate('ollama:local', {
      provider: 'ollama', backend: 'local-model', model: 'qwen3', profileRef: 'device', authSourceRef: 'none',
      locality: 'local', accessClass: 'local', costClass: 'free', privacyClass: 'device',
    })
    const remote = candidate('openai:remote', {
      provider: 'openai', backend: 'api', model: 'gpt-5', profileRef: 'team', authSourceRef: 'openai-key',
      locality: 'remote', accessClass: 'api', costClass: 'high', privacyClass: 'provider',
    })
    const decision = selectExecutionRoute(policy([local, remote], {
      originCandidateId: local.id,
      preferenceOrder: [local.id, remote.id],
    }), { decidedAt: DECIDED_AT })

    expect(decision.selectedCandidateId).toBe(local.id)
    expect(decision.fallbackCandidateIds).toEqual([])
    expect(decision.rejected.find((item) => item.candidateId === remote.id)?.codes).toEqual(['TRANSITION_APPROVAL_REQUIRED'])
    expect(decision.transitions).toEqual([{
      fromCandidateId: local.id,
      toCandidateId: remote.id,
      kinds: ['local-to-remote', 'identity-change', 'privacy-downgrade', 'higher-cost'],
      approved: false,
    }])
  })

  it('requires explicit subscription-to-API approval and admits only the approved transition', () => {
    const subscription = candidate('codex:subscription')
    const api = candidate('openai:api', {
      provider: 'openai', backend: 'api', accessClass: 'api', authSourceRef: 'openai-key',
    })
    const required = classifyRouteTransition(subscription, api)
    const decision = selectExecutionRoute(policy([subscription, api], {
      originCandidateId: subscription.id,
      approvedTransitions: required,
      preferenceOrder: [subscription.id, api.id],
    }), { decidedAt: DECIDED_AT })

    expect(required).toContain('subscription-to-api')
    expect(decision.fallbackCandidateIds).toEqual([api.id])
    expect(decision.transitions?.[0]?.approved).toBe(true)
  })

  it('keeps same-candidate retry distinct from compatible fallback', () => {
    expect(planCandidateRecovery({
      candidateId: 'ollama:local', failureCode: 'ADAPTER_TIMEOUT', recoverable: true,
      attempt: 1, maxSameCandidateRetries: 1, compatibleFallbackCandidateIds: ['ollama:local-compatible'],
    })).toEqual({ kind: 'retry-same-candidate', candidateId: 'ollama:local', nextAttempt: 2 })

    expect(planCandidateRecovery({
      candidateId: 'ollama:local', failureCode: 'ADAPTER_TIMEOUT', recoverable: true,
      attempt: 2, maxSameCandidateRetries: 1, compatibleFallbackCandidateIds: ['ollama:local-compatible'],
    })).toEqual({ kind: 'fallback-candidate', candidateId: 'ollama:local-compatible' })

    expect(planCandidateRecovery({
      candidateId: 'ollama:local', failureCode: 'AGENT_ABORTED', recoverable: true,
      attempt: 1, maxSameCandidateRetries: 3, compatibleFallbackCandidateIds: ['openai:remote'],
    })).toEqual({ kind: 'stop', code: 'AGENT_ABORTED' })
  })

  it('materializes live Ollama health, inventory, and model capabilities', async () => {
    const capabilities: LocalModelCapabilityProfile = {
      text: true, vision: true, tools: true, structuredOutput: true,
      thinking: false, embedding: false, contextTokens: 32_768, evidence: 'ollama-show',
    }
    const adapter = {
      providerId: 'ollama',
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, providerId: 'ollama', sdkInstalled: true, cliAvailable: false }),
      listModels: vi.fn().mockResolvedValue([{ id: 'qwen3', name: 'qwen3' }]),
      inspectModel: vi.fn().mockResolvedValue({ capabilities }),
      getCapabilities: () => ({ supportsResume: false, supportsFork: false, supportsToolCalls: true, supportsStreaming: true, supportsCostUsage: false }),
    } as unknown as AgentCLIAdapter
    const adapters = new Map([['ollama', adapter] as const])

    const [materialized] = await materializeRoutingCandidates([{
      id: 'ollama:direct:qwen3', provider: 'ollama', backend: 'local-model', model: 'qwen3',
      locality: 'local', accessClass: 'local', costClass: 'free', privacyClass: 'device',
    }], adapters)

    expect(materialized).toMatchObject({
      id: 'ollama:direct:qwen3', modelAvailable: true, health: { status: 'healthy' },
    })
    expect(materialized?.capabilities).toEqual(expect.arrayContaining(['supportsToolCalls', 'text', 'vision', 'tools', 'structuredOutput', 'contextTokens']))
  })

  it('keeps local OpenAI-compatible and remote API candidates separate', () => {
    const localCompatible = candidate('ollama:openai-compatible:qwen3', {
      provider: 'ollama', backend: 'local-model', locality: 'local', accessClass: 'local',
      costClass: 'free', privacyClass: 'private-network',
    })
    const remoteApi = candidate('openai:api:gpt-5', {
      provider: 'openai', backend: 'api', locality: 'remote', accessClass: 'api', costClass: 'high',
    })
    const decision = selectExecutionRoute(policy([remoteApi, localCompatible], {
      requirements: { backends: ['local-model'] },
    }), { decidedAt: DECIDED_AT })

    expect(decision.selectedCandidateId).toBe(localCompatible.id)
    expect(decision.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: remoteApi.id, codes: ['BACKEND_UNAVAILABLE'] }),
    ]))
  })
})
