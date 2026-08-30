import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AgentCLIAdapter,
  AgentInput,
} from '../types.js'
import {
  assertAdapterExecutionControlsAdmitted,
  buildExecutionControlAdmission,
} from '../execution-control-admission.js'
import {
  projectOpenAITools,
  type OpenAIToolProjection,
} from './openai-tool-calls.js'
import type { OpenAIToolWire } from './openai-types.js'

export interface AdmittedOpenAIToolProjectionSnapshot {
  readonly admission: AdapterExecutionControlAdmission
  readonly projection: Readonly<OpenAIToolProjection>
  readonly requirementSha256: string
}

/**
 * Owns the admitted/executing tool-projection state for the OpenAI adapter.
 *
 * An admission stores the exact projection it was judged on; the later run
 * consumes that snapshot only when the same admission still holds, so the
 * projection that reaches the wire is the one that was admitted.
 */
export class OpenAIToolProjectionLedger {
  private readonly admittedToolProjectionSnapshots = new WeakMap<
    AgentInput,
    AdmittedOpenAIToolProjectionSnapshot
  >()
  private readonly executingToolProjections = new WeakMap<
    AgentInput,
    Readonly<OpenAIToolProjection>
  >()

  admitExecutionControls(
    input: AgentInput,
    requirement: AdapterExecutionControlRequirement,
  ): AdapterExecutionControlAdmission {
    this.admittedToolProjectionSnapshots.delete(input)
    const projection = projectOpenAITools(input, requirement)
    const admitted = !Object.hasOwn(projection, 'tools')
      && !Object.hasOwn(projection, 'toolChoice')
    const admission = buildExecutionControlAdmission({
      providerId: 'openai',
      requirement,
      status: admitted ? 'admitted' : 'rejected',
      enforcement: admitted ? 'provider-pre-dispatch' : 'unsupported',
      ...(admitted
        ? {}
        : { blockers: ['zero_tool_dispatch_not_enforced'] }),
    })
    if (admission.status === 'admitted') {
      this.admittedToolProjectionSnapshots.set(input, {
        admission,
        projection,
        requirementSha256: admission.requirementSha256,
      })
    }
    return admission
  }

  resolveFinalToolProjection(
    adapter: AgentCLIAdapter,
    input: AgentInput,
  ): Readonly<OpenAIToolProjection> {
    const storedSnapshot = this.takeAdmittedToolProjectionSnapshot(input)
    if (storedSnapshot !== undefined) {
      return this.validateStoredToolProjectionSnapshot(adapter, input, storedSnapshot)
        .projection
    }

    const admission = assertAdapterExecutionControlsAdmitted(adapter, input)
    return admission === undefined
      ? projectOpenAITools(input)
      : this.consumeAdmittedToolProjectionSnapshot(input, admission).projection
  }

  markExecuting(
    input: AgentInput,
    projection: Readonly<OpenAIToolProjection>,
  ): void {
    this.executingToolProjections.set(input, projection)
  }

  clearExecuting(input: AgentInput): void {
    this.executingToolProjections.delete(input)
  }

  takeExecutingOrResolve(
    adapter: AgentCLIAdapter,
    input: AgentInput,
  ): Readonly<OpenAIToolProjection> {
    const projection = this.executingToolProjections.get(input)
      ?? this.resolveFinalToolProjection(adapter, input)
    this.executingToolProjections.delete(input)
    return projection
  }

  private validateStoredToolProjectionSnapshot(
    adapter: AgentCLIAdapter,
    input: AgentInput,
    snapshot: AdmittedOpenAIToolProjectionSnapshot,
  ): AdmittedOpenAIToolProjectionSnapshot {
    const validationFacade = new Proxy(adapter, {
      get: (target, property, receiver) => {
        if (property === 'admitExecutionControls') {
          return () => snapshot.admission
        }
        if (property === 'getCapabilities') {
          return target.getCapabilities.bind(target)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const admission = assertAdapterExecutionControlsAdmitted(
      validationFacade,
      input,
    )
    if (
      admission === undefined
      || admission.requirementSha256 !== snapshot.requirementSha256
    ) {
      throw this.executionControlSnapshotError(
        snapshot.admission,
        'execution_control_request_snapshot_mismatch',
      )
    }
    return snapshot
  }

  private takeAdmittedToolProjectionSnapshot(
    input: AgentInput,
  ): AdmittedOpenAIToolProjectionSnapshot | undefined {
    const snapshot = this.admittedToolProjectionSnapshots.get(input)
    this.admittedToolProjectionSnapshots.delete(input)
    return snapshot
  }

  private consumeAdmittedToolProjectionSnapshot(
    input: AgentInput,
    admission: AdapterExecutionControlAdmission,
  ): AdmittedOpenAIToolProjectionSnapshot {
    const snapshot = this.takeAdmittedToolProjectionSnapshot(input)
    if (
      snapshot === undefined
      || snapshot.requirementSha256 !== admission.requirementSha256
    ) {
      throw this.executionControlSnapshotError(
        admission,
        'execution_control_request_snapshot_missing',
      )
    }
    return snapshot
  }

  private executionControlSnapshotError(
    admission: AdapterExecutionControlAdmission,
    blocker: 'execution_control_request_snapshot_mismatch'
      | 'execution_control_request_snapshot_missing',
  ): ForgeError {
    return new ForgeError({
      code: 'CAPABILITY_DENIED',
      message: 'OpenAI admission has no matching final tool projection',
      recoverable: false,
      context: {
        providerId: 'openai',
        executionControlBlocker: blocker,
        admission,
      },
    })
  }
}

export function mutableChatToolProjection(
  projection: Readonly<OpenAIToolProjection>,
): { tools?: OpenAIToolWire[]; toolChoice?: unknown } {
  return {
    ...(projection.tools ? { tools: [...projection.tools] } : {}),
    ...(Object.hasOwn(projection, 'toolChoice')
      ? { toolChoice: projection.toolChoice }
      : {}),
  }
}
