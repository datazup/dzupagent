import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRouteCandidate,
  McpServerDescriptor,
  ProviderAuthSourceDescriptor,
  ProviderExecutionBackend,
} from '@dzupagent/runtime-contracts'

import type { AgentEvent } from './events.js'
import type { AgentInput, AgentCLIAdapter } from './execution.js'
import type { AdapterProviderId } from './provider.js'
import type { TokenUsage } from './token-usage.js'

export type ControlledExecutionTerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export interface ControlledExecutionCompletion {
  executionId: string
  status: ControlledExecutionTerminalStatus
  providerId: AdapterProviderId
  backend: ProviderExecutionBackend
  sessionId?: string | undefined
  usage?: TokenUsage | undefined
  costCents?: number | undefined
  output?: unknown
  error?: { code: string; message: string } | undefined
  metadata?: Record<string, unknown> | undefined
}

/** A single controlled execution with one event stream and terminal promise. */
export interface ControlledExecutionHandle {
  readonly executionId: string
  readonly events: AsyncIterable<AgentEvent>
  readonly completion: Promise<ControlledExecutionCompletion>
  cancel(reason?: string): Promise<void>
}

/** Optional companion contract; legacy AgentCLIAdapter remains source compatible. */
export interface ControlledAgentCLIAdapter extends AgentCLIAdapter {
  executeControlled(input: AgentInput): ControlledExecutionHandle
}

export type ExecutionProjectionDiagnosticCode =
  | 'REQUEST_KIND_UNSUPPORTED'
  | 'ROUTE_SELECTION_REQUIRED'
  | 'PROMPT_REFERENCE_UNRESOLVED'
  | 'PROMPT_BINDINGS_UNRESOLVED'
  | 'TOOL_POLICY_UNSUPPORTED'
  | 'EFFECT_POLICY_UNSUPPORTED'
  | 'CANCELLATION_RESOLVER_REQUIRED'
  | 'EVIDENCE_REQUIREMENT_UNSUPPORTED'
  | 'AUTH_PROJECTION_REQUIRED'
  | 'MCP_PROJECTION_REQUIRED'
  | 'CAPABILITY_REQUIREMENT_UNMET'
  | 'OUTPUT_SCHEMA_REFERENCE_UNRESOLVED'
  | 'OUTPUT_FORMAT_UNSUPPORTED'

export interface ExecutionProjectionDiagnostic {
  code: ExecutionProjectionDiagnosticCode
  path: string
  message: string
  severity: 'error' | 'warning'
}

export interface ExecutionRequestProjectionOptions {
  selectedCandidate?: ExecutionRouteCandidate | undefined
  signal?: AbortSignal | undefined
  supportedCapabilities?: readonly string[] | undefined
  /** True only when the host will resolve and inject referenced auth sources. */
  projectAuthSources?: boolean | undefined
  /** True only when the host will project MCP descriptors into the provider runtime. */
  projectMcpServers?: boolean | undefined
}

export interface ExecutionRequestProjection {
  input?: AgentInput | undefined
  diagnostics: ExecutionProjectionDiagnostic[]
  authSources: readonly ProviderAuthSourceDescriptor[]
  mcpServers: readonly McpServerDescriptor[]
  candidate?: ExecutionRouteCandidate | undefined
}

/**
 * Projects supported canonical request fields to AgentInput and reports every
 * required semantic that needs a host-side projection. It never selects a
 * route, resolves secrets, or silently weakens policy.
 */
export function projectExecutionRequestToAgentInput(
  request: ExecutionRequest,
  options: ExecutionRequestProjectionOptions = {},
): ExecutionRequestProjection {
  const diagnostics: ExecutionProjectionDiagnostic[] = []
  const candidate = options.selectedCandidate
  const knownCandidate = candidate
    ? request.route.candidates.some((item) => item.id === candidate.id)
    : false

  if (!candidate || !knownCandidate) {
    diagnostics.push(error('ROUTE_SELECTION_REQUIRED', 'route', 'A materialized route candidate must be selected by the host.'))
  }

  if (request.kind === 'worker.dispatch') {
    diagnostics.push(error('REQUEST_KIND_UNSUPPORTED', 'kind', 'Worker dispatch requests cannot be projected to AgentInput.'))
  }

  request.prompt.layers.forEach((layer, index) => {
    if (layer.ref && !layer.content) {
      diagnostics.push(
        error(
          'PROMPT_REFERENCE_UNRESOLVED',
          `prompt.layers[${index}].ref`,
          `The host must resolve prompt reference: ${layer.ref}`,
        ),
      )
    }
  })

  if (Object.keys(request.prompt.bindings).length > 0) {
    diagnostics.push(
      error(
        'PROMPT_BINDINGS_UNRESOLVED',
        'prompt.bindings',
        'The host must render canonical prompt bindings before adapter projection.',
      ),
    )
  }

  if (request.tools.mode !== 'none') {
    diagnostics.push(error('TOOL_POLICY_UNSUPPORTED', 'tools', 'AgentInput cannot enforce the canonical tool grant policy.'))
  }

  if (request.effects.effectClass && !['read', 'compute', 'llm'].includes(request.effects.effectClass)) {
    diagnostics.push(error('EFFECT_POLICY_UNSUPPORTED', 'effects.effectClass', `AgentInput cannot enforce ${request.effects.effectClass} effects.`))
  }

  if (request.cancellation.signalRef && !options.signal) {
    diagnostics.push(error('CANCELLATION_RESOLVER_REQUIRED', 'cancellation.signalRef', 'The host must resolve signalRef to an AbortSignal.'))
  }

  if (request.evidenceRequirements.length > 0) {
    diagnostics.push(error('EVIDENCE_REQUIREMENT_UNSUPPORTED', 'evidenceRequirements', 'AgentInput does not enforce evidence requirements.'))
  }

  const authSources = request.authSources ?? []
  if (authSources.length > 0 && !options.projectAuthSources) {
    diagnostics.push(error('AUTH_PROJECTION_REQUIRED', 'authSources', 'The host must resolve referenced authentication sources.'))
  }

  const mcpServers = request.mcpServers ?? []
  if (mcpServers.length > 0 && !options.projectMcpServers) {
    diagnostics.push(error('MCP_PROJECTION_REQUIRED', 'mcpServers', 'The host must project MCP server descriptors.'))
  }

  const supported = new Set(options.supportedCapabilities ?? candidate?.capabilities ?? [])
  request.capabilityRequirements
    ?.filter((requirement) => requirement.required && !supported.has(requirement.capability))
    .forEach((requirement, index) => {
      diagnostics.push(error('CAPABILITY_REQUIREMENT_UNMET', `capabilityRequirements[${index}]`, `Required capability is unavailable: ${requirement.capability}`))
    })

  if (request.output.format === 'unknown') {
    diagnostics.push(error('OUTPUT_FORMAT_UNSUPPORTED', 'output.format', 'Unknown output format cannot be projected deterministically.'))
  }
  if (request.output.schemaRef && !request.output.schema) {
    diagnostics.push(
      error(
        'OUTPUT_SCHEMA_REFERENCE_UNRESOLVED',
        'output.schemaRef',
        `The host must resolve output schema reference: ${request.output.schemaRef}`,
      ),
    )
  }

  const systemPrompt = request.prompt.layers
    .filter((layer) => layer.kind !== 'task')
    .map(renderPromptLayer)
    .filter((value): value is string => Boolean(value))
    .join('\n\n') || undefined
  const prompt = request.prompt.layers
    .filter((layer) => layer.kind === 'task')
    .map(renderPromptLayer)
    .filter((value): value is string => Boolean(value))
    .join('\n\n')

  const input: AgentInput = {
    prompt,
    correlationId: request.correlationId,
    workingDirectory: request.policy.workingDirectory,
    maxTurns: request.policy.maxIterations,
    maxBudgetUsd: request.policy.budgetCents === undefined ? undefined : request.policy.budgetCents / 100,
    signal: options.signal,
    systemPrompt,
    outputSchema: request.output.format === 'json' ? request.output.schema : undefined,
    policyContext: {
      projectedGuardrails: {
        maxIterations: request.policy.maxIterations,
        maxCostCents: request.policy.budgetCents,
      },
    },
  }

  return {
    input: diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? undefined : input,
    diagnostics,
    authSources,
    mcpServers,
    candidate: knownCandidate ? candidate : undefined,
  }
}

function renderPromptLayer(layer: ExecutionRequest['prompt']['layers'][number]): string | undefined {
  return layer.content
}

function error(
  code: ExecutionProjectionDiagnosticCode,
  path: string,
  message: string,
): ExecutionProjectionDiagnostic {
  return { code, path, message, severity: 'error' }
}

/** Convenience type for hosts correlating adapter completion to canonical results. */
export type CanonicalExecutionCompletion = Pick<
  ExecutionResult,
  'requestId' | 'correlationId' | 'status'
>
