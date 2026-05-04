/**
 * ApprovalPipelineStep — extracted from OrchestratorFacade.
 *
 * Wraps an event stream with an AdapterApprovalGate when one is configured
 * and the caller requests approval gating. Centralises the small bit of
 * boilerplate that builds an `ApprovalContext` from the public API options.
 */

import type {
  AdapterApprovalGate,
  ApprovalContext,
} from '../approval/adapter-approval.js'
import type {
  AdapterProviderId,
  AgentEvent,
  AgentStreamEvent,
} from '../types.js'

export interface BuildApprovalContextArgs {
  prompt: string
  providerId?: AdapterProviderId | undefined
  approvalRunId?: string | undefined
  tags?: string[] | undefined
}

export class ApprovalPipelineStep {
  constructor(private readonly _gate: AdapterApprovalGate | undefined) {}

  /** Returns true when a gate is configured (i.e. wrapping is meaningful). */
  get enabled(): boolean {
    return this._gate !== undefined
  }

  /** Build an ApprovalContext from the run-level args. */
  buildContext(args: BuildApprovalContextArgs): ApprovalContext {
    return {
      runId: args.approvalRunId ?? crypto.randomUUID(),
      description: args.prompt.slice(0, 200),
      providerId: args.providerId ?? ('auto' as AdapterProviderId),
      tags: args.tags,
    }
  }

  /**
   * Wrap a stream with the approval gate when both gating is requested and
   * a gate is configured. Otherwise the stream is returned untouched.
   */
  wrap<T extends AgentEvent | AgentStreamEvent>(
    stream: AsyncGenerator<T, void, undefined>,
    args: BuildApprovalContextArgs & { requireApproval: boolean | undefined },
  ): AsyncGenerator<T, void, undefined> {
    if (!this._gate || !args.requireApproval) return stream
    const context = this.buildContext(args)
    return this._gate.guard(context, stream) as AsyncGenerator<T, void, undefined>
  }
}
