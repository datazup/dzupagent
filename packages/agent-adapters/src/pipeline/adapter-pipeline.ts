/**
 * AdapterPipeline — composes the four pipeline steps used by
 * OrchestratorFacade to prepare an AgentInput and wrap the resulting
 * event stream.
 *
 * The pipeline is a thin coordinator: each step is independently testable
 * and can be replaced (e.g. by a mock) when constructing the facade.
 */

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
} from '../types.js'
import type { AdapterPolicy } from '../policy/policy-compiler.js'

import { PolicyEnforcementPipeline } from './policy-enforcement-pipeline.js'
import {
  ApprovalPipelineStep,
  type BuildApprovalContextArgs,
} from './approval-pipeline-step.js'
import { GuardrailsPipelineStep } from './guardrails-pipeline-step.js'
import { UCLEnrichmentStep } from './ucl-enrichment-step.js'

export interface PreparePipelineArgs {
  input: AgentInput
  preferredProvider?: AdapterProviderId | undefined
  policy?: AdapterPolicy | undefined
}

export class AdapterPipeline {
  constructor(
    public readonly policy: PolicyEnforcementPipeline,
    public readonly approval: ApprovalPipelineStep,
    public readonly guardrails: GuardrailsPipelineStep,
    public readonly ucl: UCLEnrichmentStep,
  ) {}

  /**
   * Run the pre-execution stages of the pipeline:
   *   1. UCL enrichment (loads skills + memory)
   *   2. Policy override application
   *
   * Mutates `input` in-place; returns it for chaining convenience.
   */
  async prepare(args: PreparePipelineArgs): Promise<AgentInput> {
    if (this.ucl.enabled) {
      await this.ucl.apply(args.input)
    }
    this.policy.applyPolicyOverrides(args.input, args.preferredProvider, args.policy)
    return args.input
  }

  /**
   * Apply post-stream wrappers (cost tracking, guardrails) and optional
   * approval gating to an event stream.
   */
  wrapStream<T extends AgentEvent | AgentStreamEvent>(
    stream: AsyncGenerator<T, void, undefined>,
    input: AgentInput,
    approvalArgs: BuildApprovalContextArgs & { requireApproval: boolean | undefined },
  ): AsyncGenerator<T, void, undefined> {
    const wrappedByGuardrails = this.guardrails.wrap(
      stream as AsyncGenerator<AgentStreamEvent, void, undefined>,
      input,
    ) as AsyncGenerator<T, void, undefined>
    return this.approval.wrap(wrappedByGuardrails, approvalArgs)
  }
}
