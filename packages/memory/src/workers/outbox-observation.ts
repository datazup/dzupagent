import { freezeWorkerValue, memoryWorkerScopeDigest } from './snapshot.js'
import { workerStateCounts } from './state-validation.js'
import type {
  InternalMemoryOutboxInspectionV1,
  InternalMemoryOutboxStateV1,
} from './types.js'

export function inspectMemoryOutboxState(
  state: InternalMemoryOutboxStateV1,
): InternalMemoryOutboxInspectionV1 {
  return freezeWorkerValue({
    schema: 'datazup.memory.outbox-inspection/v1',
    revision: state.revision,
    sequence: state.sequence,
    stateDigest: state.stateDigest,
    counts: workerStateCounts(state.entries),
    entries: state.entries.map(entry => ({
      scopeDigest: memoryWorkerScopeDigest(entry.envelope.job.scope),
      envelopeId: entry.envelope.envelopeId,
      envelopeDigest: entry.envelope.envelopeDigest,
      jobId: entry.envelope.job.jobId,
      jobDigest: entry.envelope.jobDigest,
      state: entry.state,
      attempt: entry.attempt,
      generation: entry.generation,
      nextAvailableAt: entry.nextAvailableAt,
    })),
    deadLetters: state.entries.flatMap(entry =>
      entry.deadLetter === undefined ? [] : [entry.deadLetter]),
    checkpoints: state.checkpoints,
  })
}
