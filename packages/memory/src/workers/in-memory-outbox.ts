import { InternalInMemoryOutboxState } from './outbox-state.js'
import {
  decodeCheckpointRequest,
  decodeClaimRequest,
  decodeFactoryOptions,
  decodeReconcileRequest,
  decodeRenewRequest,
  decodeRunClaimedRequest,
} from './requests.js'
import type {
  InternalMemoryOutboxInspectionV1,
  InternalMemoryOutboxStateV1,
  MemoryConsolidationPort,
  MemoryOutboxEnvelopeV1,
  MemoryWorkerOutcomeV1,
} from './types.js'
import { sealMemoryOutboxEnvelopeV1 } from './validation-contracts.js'
import {
  reconcileMemoryEnvelope,
  runClaimedMemoryEnvelope,
} from './worker-runtime.js'

interface InMemoryMemoryOutbox {
  /** Validate and digest-bind a caller-timestamped, reference-only envelope. */
  prepare(input: unknown): MemoryOutboxEnvelopeV1
  /** Retain an envelope or return an exact idempotent replay/conflict outcome. */
  enqueue(input: unknown): MemoryWorkerOutcomeV1
  /** Claim at most one due envelope using a generation-fenced lease. */
  claim(input: unknown): MemoryWorkerOutcomeV1
  /** Renew a non-executing lease; the returned generation supersedes the old lease. */
  renew(input: unknown): MemoryWorkerOutcomeV1
  /** Run one claimed envelope through current admission and a bounded injected port. */
  runClaimed(input: unknown, port: MemoryConsolidationPort): Promise<MemoryWorkerOutcomeV1>
  /** Reconcile one ambiguous result before any retry can be scheduled. */
  reconcile(input: unknown, port: MemoryConsolidationPort): Promise<MemoryWorkerOutcomeV1>
  /** Retain a digest-bound checkpoint only when revision and state digest still match. */
  checkpoint(input: unknown): MemoryWorkerOutcomeV1
  /** Return a content-free operational view. */
  inspect(): InternalMemoryOutboxInspectionV1
  /** Export the bounded state for host-owned persistence. */
  exportState(): InternalMemoryOutboxStateV1
}

/**
 * Create an inert reference adapter. It owns no timer, scheduler, provider,
 * canonical memory write, filesystem, network, or production authority.
 */
export function createInMemoryMemoryOutbox(options?: unknown): InMemoryMemoryOutbox {
  const state = new InternalInMemoryOutboxState(decodeFactoryOptions(options))
  return Object.freeze({
    prepare: (input: unknown) => sealMemoryOutboxEnvelopeV1(input),
    enqueue: (input: unknown) => state.enqueue(input),
    claim: (input: unknown) => state.claim(decodeClaimRequest(input)),
    renew: (input: unknown) => state.renew(decodeRenewRequest(input)),
    runClaimed: (input: unknown, port: MemoryConsolidationPort) =>
      runClaimedMemoryEnvelope(state, decodeRunClaimedRequest(input), port),
    reconcile: (input: unknown, port: MemoryConsolidationPort) =>
      reconcileMemoryEnvelope(state, decodeReconcileRequest(input), port),
    checkpoint: (input: unknown) => state.checkpoint(decodeCheckpointRequest(input)),
    inspect: () => state.inspect(),
    exportState: () => state.exportState(),
  })
}
