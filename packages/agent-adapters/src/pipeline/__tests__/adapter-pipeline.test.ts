import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'

import { ProviderAdapterRegistry } from '../../registry/adapter-registry.js'
import {
  AdapterPipeline,
  ApprovalPipelineStep,
  GuardrailsPipelineStep,
  PolicyEnforcementPipeline,
  UCLEnrichmentStep,
} from '../index.js'
import type { AdapterProviderId, AgentInput, AgentStreamEvent } from '../../types.js'

async function* sampleStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
  yield {
    type: 'adapter:started',
    providerId: 'codex' as AdapterProviderId,
    sessionId: 's',
    timestamp: Date.now(),
  }
}

function buildPipeline(): {
  pipeline: AdapterPipeline
  policy: PolicyEnforcementPipeline
  approval: ApprovalPipelineStep
  guardrails: GuardrailsPipelineStep
  ucl: UCLEnrichmentStep
} {
  const bus = createEventBus()
  const registry = new ProviderAdapterRegistry()
  const policy = new PolicyEnforcementPipeline(registry)
  const approval = new ApprovalPipelineStep(undefined)
  const guardrails = new GuardrailsPipelineStep(undefined, undefined)
  const ucl = new UCLEnrichmentStep(registry, bus, undefined)
  return {
    pipeline: new AdapterPipeline(policy, approval, guardrails, ucl),
    policy,
    approval,
    guardrails,
    ucl,
  }
}

describe('AdapterPipeline', () => {
  it('exposes its four steps as readonly fields', () => {
    const { pipeline, policy, approval, guardrails, ucl } = buildPipeline()
    expect(pipeline.policy).toBe(policy)
    expect(pipeline.approval).toBe(approval)
    expect(pipeline.guardrails).toBe(guardrails)
    expect(pipeline.ucl).toBe(ucl)
  })

  it('prepare() skips UCL when not enabled', async () => {
    const { pipeline, ucl } = buildPipeline()
    const applySpy = vi.spyOn(ucl, 'apply')
    const input: AgentInput = { prompt: 'p' }
    await pipeline.prepare({ input })
    expect(applySpy).not.toHaveBeenCalled()
  })

  it('prepare() calls UCL.apply when UCL is enabled', async () => {
    const bus = createEventBus()
    const registry = new ProviderAdapterRegistry()
    const ucl = new UCLEnrichmentStep(registry, bus, { projectRoot: process.cwd() })
    const applySpy = vi.spyOn(ucl, 'apply').mockResolvedValue(undefined)
    const pipeline = new AdapterPipeline(
      new PolicyEnforcementPipeline(registry),
      new ApprovalPipelineStep(undefined),
      new GuardrailsPipelineStep(undefined, undefined),
      ucl,
    )
    const input: AgentInput = { prompt: 'p' }
    await pipeline.prepare({ input })
    expect(applySpy).toHaveBeenCalledTimes(1)
  })

  it('prepare() invokes policy.applyPolicyOverrides with the supplied policy', async () => {
    const { pipeline, policy } = buildPipeline()
    const applySpy = vi.spyOn(policy, 'applyPolicyOverrides')
    const input: AgentInput = { prompt: 'p' }
    await pipeline.prepare({ input, preferredProvider: 'codex' as AdapterProviderId })
    expect(applySpy).toHaveBeenCalledWith(input, 'codex', undefined)
  })

  it('wrapStream() routes through guardrails and approval in order', async () => {
    const { pipeline, guardrails, approval } = buildPipeline()
    const grSpy = vi.spyOn(guardrails, 'wrap')
    const apSpy = vi.spyOn(approval, 'wrap')
    const wrapped = pipeline.wrapStream(sampleStream(), {
      prompt: 'p',
      requireApproval: undefined,
    })
    const out: AgentStreamEvent[] = []
    for await (const e of wrapped) out.push(e)
    expect(grSpy).toHaveBeenCalledTimes(1)
    expect(apSpy).toHaveBeenCalledTimes(1)
    // Guardrails wraps first; approval wraps the guardrail-wrapped stream.
    expect(grSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      apSpy.mock.invocationCallOrder[0]!,
    )
  })

  it('wrapStream() returns the source unchanged when no wrappers are active', async () => {
    const { pipeline } = buildPipeline()
    const out: AgentStreamEvent[] = []
    for await (const e of pipeline.wrapStream(sampleStream(), {
      prompt: 'p',
      requireApproval: undefined,
    })) {
      out.push(e)
    }
    expect(out).toHaveLength(1)
  })
})
