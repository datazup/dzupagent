import type {
  InternalFactoryOptionsV1,
} from './requests.js'
import type { InternalMemoryOutboxStateV1 } from './types.js'

export function assertMemoryOutboxCapacity(
  state: InternalMemoryOutboxStateV1,
  options: InternalFactoryOptionsV1,
): void {
  const deadLetters = state.entries.filter(entry => entry.deadLetter !== undefined).length
  if (state.entries.length > options.limits.entries
    || deadLetters > options.limits.deadLetters
    || state.checkpoints.length > options.limits.checkpoints) {
    throw new TypeError('seed exceeds configured memory outbox capacity')
  }
}
