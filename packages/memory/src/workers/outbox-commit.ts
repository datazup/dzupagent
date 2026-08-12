import type { InternalFactoryOptionsV1 } from './requests.js'
import { freezeWorkerValue } from './snapshot.js'
import {
  entryStorageKey,
  sealMemoryOutboxStateV1,
} from './state-validation.js'
import type {
  InternalMemoryOutboxEntryV1,
  InternalMemoryOutboxStateV1,
  MemoryWorkerCheckpointV1,
} from './types.js'
import { assertMemoryOutboxCapacity } from './outbox-capacity.js'

export function commitMemoryOutboxState(
  state: InternalMemoryOutboxStateV1,
  entries: readonly InternalMemoryOutboxEntryV1[],
  options: InternalFactoryOptionsV1,
  checkpoints: readonly MemoryWorkerCheckpointV1[] = state.checkpoints,
): InternalMemoryOutboxStateV1 {
  const revision = state.revision + 1
  const next = sealMemoryOutboxStateV1({
    schema: 'datazup.memory.in-memory-outbox-state/v1',
    revision,
    sequence: revision,
    entries: [...entries].sort((left, right) =>
      entryStorageKey(left).localeCompare(entryStorageKey(right))),
    checkpoints,
  })
  assertMemoryOutboxCapacity(next, options)
  return freezeWorkerValue(next)
}
