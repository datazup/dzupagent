import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AdapterRunExecutionRequest,
  ExecutionRequest,
} from '@dzupagent/runtime-contracts'

import {
  projectExecutionRequestToAgentInput,
  type AgentCLIAdapter,
  type ControlledAgentCLIAdapter,
  type ControlledExecutionCompletion,
  type ControlledExecutionHandle,
} from '../index.js'

function request(
  overrides: Partial<AdapterRunExecutionRequest> = {},
): AdapterRunExecutionRequest {
  return {
    schema: 'dzupagent.executionRequest/v1',
    kind: 'adapter.run',
    requestId: 'request-1',
    correlationId: 'correlation-1',
    attempt: 1,
    source: { nodeId: 'node-1', nodePath: 'node-1' },
    prompt: {
      layers: [
        { kind: 'system', content: 'Be precise.' },
        { kind: 'task', content: 'Inspect the repository.' },
      ],
      bindings: {},
    },
    tools: { mode: 'none', grants: [] },
    output: { key: 'result', format: 'json', schema: { type: 'object' } },
    route: {
      id: 'request-1:route',
      requestId: 'request-1',
      strategy: 'fixed',
      candidates: [{ id: 'claude-cli', provider: 'claude', backend: 'cli', capabilities: ['code'] }],
      hardConstraints: [],
      preferenceOrder: [],
      fallback: 'none',
      maxSelectionLatencyMs: 100,
    },
    policy: { workingDirectory: '/workspace', maxIterations: 4, budgetCents: 250 },
    effects: { effectClass: 'compute', idempotency: 'idempotent' },
    cancellation: { mode: 'cooperative' },
    evidenceRequirements: [],
    capabilityRequirements: [{ capability: 'code', required: true }],
    adapter: { promptPreparation: 'auto' },
    ...overrides,
  }
}

describe('controlled execution contracts', () => {
  it('keeps the legacy adapter source-compatible and adds an optional companion', () => {
    expectTypeOf<ControlledAgentCLIAdapter>().toMatchTypeOf<AgentCLIAdapter>()
    expectTypeOf<ControlledExecutionHandle['completion']>().toEqualTypeOf<Promise<ControlledExecutionCompletion>>()
    expectTypeOf<ControlledExecutionHandle['cancel']>().toBeFunction()
  })

  it('preserves supported canonical semantics in AgentInput', () => {
    const canonical = request()
    const projection = projectExecutionRequestToAgentInput(canonical, {
      selectedCandidate: canonical.route.candidates[0],
    })

    expect(projection.diagnostics).toEqual([])
    expect(projection.input).toMatchObject({
      prompt: 'Inspect the repository.',
      systemPrompt: 'Be precise.',
      workingDirectory: '/workspace',
      maxTurns: 4,
      maxBudgetUsd: 2.5,
      correlationId: 'correlation-1',
      outputSchema: { type: 'object' },
      policyContext: { projectedGuardrails: { maxIterations: 4, maxCostCents: 250 } },
    })
  })

  it('reports required host projections instead of dropping semantics', () => {
    const canonical = request({
      tools: { mode: 'explicit', grants: [{ toolRef: 'browser' }] },
      cancellation: { mode: 'cooperative', signalRef: 'cancel://request-1' },
      evidenceRequirements: [{ kind: 'sanitized-evidence', ref: 'evidence://required' }],
      authSources: [{ id: 'claude-local', provider: 'claude', location: 'local', kind: 'cli-session' }],
      mcpServers: [{ id: 'research', transport: { kind: 'http', url: 'https://example.test/mcp' } }],
      capabilityRequirements: [{ capability: 'browser.playwright', required: true }],
    })

    const projection = projectExecutionRequestToAgentInput(canonical, {
      selectedCandidate: canonical.route.candidates[0],
    })

    expect(projection.input).toBeUndefined()
    expect(projection.diagnostics.map(({ code }) => code)).toEqual([
      'TOOL_POLICY_UNSUPPORTED',
      'CANCELLATION_RESOLVER_REQUIRED',
      'EVIDENCE_REQUIREMENT_UNSUPPORTED',
      'AUTH_PROJECTION_REQUIRED',
      'MCP_PROJECTION_REQUIRED',
      'CAPABILITY_REQUIREMENT_UNMET',
    ])
    expect(projection.authSources).toEqual(canonical.authSources)
    expect(projection.mcpServers).toEqual(canonical.mcpServers)
  })

  it('requires route selection and rejects worker dispatch projection', () => {
    const canonical: ExecutionRequest = {
      ...request({ capabilityRequirements: [] }),
      kind: 'worker.dispatch',
      worker: { dispatchId: 'dispatch-1' },
    }
    const projection = projectExecutionRequestToAgentInput(canonical)

    expect(projection.diagnostics.map(({ code }) => code)).toEqual([
      'ROUTE_SELECTION_REQUIRED',
      'REQUEST_KIND_UNSUPPORTED',
    ])
  })

  it('does not silently stringify unresolved prompt or schema references', () => {
    const canonical = request({
      prompt: {
        layers: [{ kind: 'task', ref: 'prompt://task' }],
        bindings: { repository: 'dzupagent' },
      },
      output: { key: 'result', format: 'json', schemaRef: 'schema://result' },
    })
    const projection = projectExecutionRequestToAgentInput(canonical, {
      selectedCandidate: canonical.route.candidates[0],
    })

    expect(projection.input).toBeUndefined()
    expect(projection.diagnostics.map(({ code }) => code)).toEqual([
      'PROMPT_REFERENCE_UNRESOLVED',
      'PROMPT_BINDINGS_UNRESOLVED',
      'OUTPUT_SCHEMA_REFERENCE_UNRESOLVED',
    ])
  })
})
