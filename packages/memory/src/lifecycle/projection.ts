import type { MemoryStatusV1 } from '../records/types.js'
import { transitionFail } from './errors.js'
import { decodeMemoryEventV1, isRetrievalEligible } from './ledger.js'
import type { MemoryEventV1, MemoryVersionChainV1 } from './types.js'
import {
  freezeValue,
  snapshotLifecycleJson,
  timestampMillis,
  translateDecodeError,
} from './validation.js'

interface MutableVersionNode {
  versionId: string
  recordDigests: `sha256:${string}`[]
  digestStatuses: Map<`sha256:${string}`, MemoryStatusV1>
  status: MemoryStatusV1
  lastTransitionType: MemoryEventV1['type']
  introducedAt: string
  lastTransitionAt: string
  predecessorVersionId?: string
  successorVersionIds: Set<string>
  retrievalEligible: boolean
  archiveRecorded: boolean
  purgeProposed: boolean
}

/** Project a strict, branch-preserving version chain from an event ledger. */
export function projectMemoryVersionChainV1(
  inputEvents: readonly MemoryEventV1[],
): MemoryVersionChainV1 {
  const snapshot = translateDecodeError(
    'invalid-event',
    () => snapshotLifecycleJson(inputEvents),
  )
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    transitionFail('invalid-event', ['events'])
  }
  const events = snapshot.map(decodeMemoryEventV1)
  validateEventLedger(events)

  const versions = new Map<string, MutableVersionNode>()
  const purgeProposals: MemoryVersionChainV1['purgeProposals'][number][] = []
  for (const event of events) {
    validateProjectedEvent(event)
    for (const [effectIndex, effect] of event.recordEffects.entries()) {
      applyRecordEffect(versions, event, effect, effectIndex)
    }
    validateRelations(versions, event)
    if (event.effect.kind === 'archive-recorded') {
      versions.get(event.currentVersionId)!.archiveRecorded = true
    }
    if (event.effect.kind === 'purge-proposed') {
      versions.get(event.currentVersionId)!.purgeProposed = true
      purgeProposals.push({
        eventId: event.eventId,
        versionId: event.currentVersionId,
        proposedAt: event.occurredAt,
        targetRefs: event.effect.targetRefs,
        tombstone: event.effect.tombstone,
      })
    }
    const current = versions.get(event.currentVersionId)
    if (!current
      || !current.recordDigests.includes(event.currentRecordDigest)
      || current.status !== event.currentStatus) {
      transitionFail('projection-conflict', ['events', String(event.sequence - 1)])
    }
  }
  validateAcyclic(versions)

  const projectedVersions = [...versions.values()]
    .sort((left, right) => left.introducedAt.localeCompare(right.introducedAt)
      || left.versionId.localeCompare(right.versionId))
    .map(node => ({
      versionId: node.versionId,
      recordDigests: [...node.recordDigests],
      status: node.status,
      introducedAt: node.introducedAt,
      lastTransitionAt: node.lastTransitionAt,
      ...(node.predecessorVersionId === undefined
        ? {}
        : { predecessorVersionId: node.predecessorVersionId }),
      successorVersionIds: [...node.successorVersionIds].sort(),
      retrievalEligible: node.retrievalEligible,
      archiveRecorded: node.archiveRecorded,
      purgeProposed: node.purgeProposed,
    }))
  const activeVersionIds = projectedVersions
    .filter(version => version.retrievalEligible)
    .map(version => version.versionId)
    .sort()
  const conflicts = [...versions.values()]
    .filter(version => version.successorVersionIds.size > 1)
    .map(version => {
      const headVersionIds = collectHeads(versions, version.versionId)
      const unresolvedHeads = headVersionIds.filter(versionId => {
        const status = versions.get(versionId)?.status
        return status === 'active' || status === 'disputed'
      })
      return {
        baseVersionId: version.versionId,
        headVersionIds,
        resolved: unresolvedHeads.length <= 1,
      }
    })
    .sort((left, right) => left.baseVersionId.localeCompare(right.baseVersionId))

  return translateDecodeError(
    'invalid-event',
    () => freezeValue({
      schema: 'datazup.memory.version-chain/v1',
      memoryId: events[0]!.memoryId,
      generation: events[0]!.generation,
      lastSequence: events.at(-1)!.sequence,
      versions: projectedVersions,
      activeVersionIds,
      conflicts,
      purgeProposals,
    }),
  )
}

function validateEventLedger(events: readonly MemoryEventV1[]): void {
  const first = events[0]!
  const identities = new Set<string>()
  let priorSequence = 0
  let priorTime = -Infinity
  for (const [index, event] of events.entries()) {
    if (event.memoryId !== first.memoryId) {
      transitionFail('identity-mismatch', ['events', String(index), 'memoryId'])
    }
    if (event.generation !== first.generation) {
      transitionFail('stale-generation', ['events', String(index), 'generation'])
    }
    if (event.sequence === priorSequence) {
      transitionFail('sequence-conflict', ['events', String(index), 'sequence'])
    }
    if (event.sequence < priorSequence) {
      transitionFail('sequence-reorder', ['events', String(index), 'sequence'])
    }
    if (event.sequence !== priorSequence + 1) {
      transitionFail('sequence-gap', ['events', String(index), 'sequence'])
    }
    const occurredAt = timestampMillis(event.occurredAt)
    if (occurredAt < priorTime) {
      transitionFail('time-reversal', ['events', String(index), 'occurredAt'])
    }
    priorSequence = event.sequence
    priorTime = occurredAt
    for (const identity of [
      `event:${event.eventId}`,
      `command:${event.commandId}`,
      `idempotency:${event.idempotencyKey}`,
    ]) {
      if (identities.has(identity)) {
        transitionFail('projection-conflict', ['events', String(index)])
      }
      identities.add(identity)
    }
  }
}

function validateProjectedEvent(event: MemoryEventV1): void {
  const [first, second] = event.recordEffects
  if (!first) transitionFail('invalid-event', ['recordEffects'])
  if (event.type === 'capture') {
    if (event.sequence !== 1
      || first.priorDigest !== undefined || first.statusFrom !== undefined
      || first.statusTo !== 'captured') {
      transitionFail('illegal-transition', ['recordEffects'])
    }
    return
  }
  if (event.sequence === 1) transitionFail('illegal-transition', ['recordEffects'])
  if (event.type === 'correct') {
    if (!second
      || first.statusFrom !== 'active'
      || first.statusTo !== 'superseded'
      || first.supersededByVersionId !== second.versionId
      || first.supersedingRecordDigest !== second.resultDigest
      || second.priorDigest !== undefined
      || second.statusFrom !== undefined
      || second.statusTo !== 'active'
      || second.supersedesVersionId !== first.versionId) {
      transitionFail('illegal-transition', ['recordEffects'])
    }
    return
  }
  if (second) transitionFail('invalid-event', ['recordEffects'])
  if (first.priorDigest === undefined || first.statusFrom === undefined) {
    transitionFail('invalid-event', ['recordEffects'])
  }
  const legal =
    (event.type === 'assess' && first.statusFrom === 'captured' && first.statusTo === 'candidate')
    || (event.type === 'require-review' && first.statusFrom === 'candidate'
      && first.statusTo === 'review-required')
    || (event.type === 'promote' && first.statusFrom === 'candidate' && first.statusTo === 'active')
    || (event.type === 'confirm' && first.statusFrom === 'review-required'
      && first.statusTo === 'active')
    || (event.type === 'reject'
      && ['captured', 'candidate', 'review-required', 'active', 'disputed'].includes(first.statusFrom)
      && first.statusTo === 'rejected')
    || (event.type === 'dispute' && first.statusFrom === 'active'
      && first.statusTo === 'disputed')
    || (event.type === 'resolve' && first.statusFrom === 'disputed'
      && ['active', 'superseded', 'revoked'].includes(first.statusTo))
    || (event.type === 'revoke' && ['active', 'disputed'].includes(first.statusFrom)
      && first.statusTo === 'revoked')
    || (event.type === 'expire' && first.statusFrom === 'active'
      && first.statusTo === 'expired')
    || (event.type === 'archive'
      && ['superseded', 'revoked', 'expired', 'rejected'].includes(first.statusFrom)
      && first.statusTo === 'archived')
    || (event.type === 'propose-purge'
      && ['superseded', 'revoked', 'expired', 'rejected', 'archived'].includes(first.statusFrom)
      && first.statusTo === first.statusFrom
      && first.priorDigest === first.resultDigest)
  if (!legal) transitionFail('illegal-transition', ['recordEffects'])
  if (event.type !== 'propose-purge' && first.priorDigest === first.resultDigest) {
    transitionFail('projection-conflict', ['recordEffects', '0', 'resultDigest'])
  }
  if (event.type === 'resolve' && first.statusTo === 'superseded'
    && (first.supersededByVersionId === undefined
      || first.supersedingRecordDigest === undefined)) {
    transitionFail('invalid-event', ['recordEffects', '0'])
  }
}

function applyRecordEffect(
  versions: Map<string, MutableVersionNode>,
  event: MemoryEventV1,
  effect: MemoryEventV1['recordEffects'][number],
  effectIndex: number,
): void {
  const path = ['recordEffects', String(effectIndex)]
  const existing = versions.get(effect.versionId)
  if (!existing) {
    if (effect.priorDigest !== undefined || effect.statusFrom !== undefined) {
      transitionFail('stale-version', path)
    }
    versions.set(effect.versionId, {
      versionId: effect.versionId,
      recordDigests: [effect.resultDigest],
      digestStatuses: new Map([[effect.resultDigest, effect.statusTo]]),
      status: effect.statusTo,
      lastTransitionType: event.type,
      introducedAt: event.occurredAt,
      lastTransitionAt: event.occurredAt,
      ...(effect.supersedesVersionId === undefined
        ? {}
        : { predecessorVersionId: effect.supersedesVersionId }),
      successorVersionIds: new Set(),
      retrievalEligible: isRetrievalEligible(effect.statusTo),
      archiveRecorded: false,
      purgeProposed: false,
    })
    return
  }
  if (effect.priorDigest === undefined || effect.statusFrom === undefined) {
    transitionFail('projection-conflict', path)
  }
  const priorKnown = existing.recordDigests.includes(effect.priorDigest)
  const linearHead = existing.recordDigests.at(-1) === effect.priorDigest
  const correctionBranch = event.type === 'correct'
    && effect.statusFrom === 'active'
    && effect.statusTo === 'superseded'
    && priorKnown
    && existing.digestStatuses.get(effect.priorDigest) === 'active'
    && existing.status === 'superseded'
    && existing.lastTransitionType === 'correct'
  if (!linearHead && !correctionBranch) {
    transitionFail('stale-digest', [...path, 'priorDigest'])
  }
  if (linearHead && existing.status !== effect.statusFrom) {
    transitionFail('projection-conflict', [...path, 'statusFrom'])
  }
  const knownResultStatus = existing.digestStatuses.get(effect.resultDigest)
  if (knownResultStatus !== undefined && knownResultStatus !== effect.statusTo) {
    transitionFail('projection-conflict', [...path, 'resultDigest'])
  }
  if (!existing.recordDigests.includes(effect.resultDigest)) {
    existing.recordDigests.push(effect.resultDigest)
  }
  existing.digestStatuses.set(effect.resultDigest, effect.statusTo)
  existing.status = effect.statusTo
  existing.lastTransitionType = event.type
  existing.lastTransitionAt = event.occurredAt
  existing.retrievalEligible = isRetrievalEligible(effect.statusTo)
}

function validateRelations(
  versions: Map<string, MutableVersionNode>,
  event: MemoryEventV1,
): void {
  for (const [effectIndex, effect] of event.recordEffects.entries()) {
    const path = ['recordEffects', String(effectIndex)]
    if (effect.supersedesVersionId !== undefined) {
      const predecessor = versions.get(effect.supersedesVersionId)
      if (!predecessor || effect.supersedesVersionId === effect.versionId) {
        transitionFail('projection-conflict', [...path, 'supersedesVersionId'])
      }
      predecessor.successorVersionIds.add(effect.versionId)
    }
    if (effect.supersededByVersionId !== undefined) {
      const successor = versions.get(effect.supersededByVersionId)
      if (!successor
        || effect.supersededByVersionId === effect.versionId
        || effect.supersedingRecordDigest === undefined
        || !successor.recordDigests.includes(effect.supersedingRecordDigest)) {
        transitionFail('projection-conflict', [...path, 'supersededByVersionId'])
      }
      versions.get(effect.versionId)!.successorVersionIds.add(effect.supersededByVersionId)
    }
  }
}

function validateAcyclic(versions: ReadonlyMap<string, MutableVersionNode>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (versionId: string): void => {
    if (visiting.has(versionId)) transitionFail('projection-conflict', ['versions'])
    if (visited.has(versionId)) return
    visiting.add(versionId)
    const node = versions.get(versionId)
    if (!node) transitionFail('projection-conflict', ['versions'])
    for (const successor of node.successorVersionIds) visit(successor)
    visiting.delete(versionId)
    visited.add(versionId)
  }
  for (const versionId of versions.keys()) visit(versionId)
}

function collectHeads(
  versions: ReadonlyMap<string, MutableVersionNode>,
  baseVersionId: string,
): readonly string[] {
  const heads = new Set<string>()
  const visiting = new Set<string>()
  const visit = (versionId: string): void => {
    if (visiting.has(versionId)) transitionFail('projection-conflict', ['versions'])
    visiting.add(versionId)
    const node = versions.get(versionId)
    if (!node) transitionFail('projection-conflict', ['versions'])
    if (node.successorVersionIds.size === 0) heads.add(versionId)
    else for (const successor of node.successorVersionIds) visit(successor)
    visiting.delete(versionId)
  }
  for (const successor of versions.get(baseVersionId)!.successorVersionIds) visit(successor)
  return [...heads].sort()
}
