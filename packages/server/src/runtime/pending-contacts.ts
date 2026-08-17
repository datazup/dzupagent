/**
 * Outstanding human-contact registry (DZUPAGENT-AGENT-H-14).
 *
 * The human-contact respond route used to accept ANY `:contactId` in the URL
 * and launder it into an approval grant. Nothing on the server recorded which
 * contact requests were actually outstanding, so there was nothing to check
 * against. This module is that record: the id of every contact request the
 * server issues for a run is written to the run's metadata, and the respond
 * route refuses ids that are not in the list.
 *
 * Stored on `run.metadata.pendingHumanContacts` as a list of contact ids so it
 * survives in any `RunStore` implementation without a schema change.
 *
 * @module runtime/pending-contacts
 */
import type { Run, RunStore } from '@dzupagent/core/persistence'

/** Metadata key holding the outstanding contact ids for a run. */
export const PENDING_CONTACTS_KEY = 'pendingHumanContacts'

/** Read the outstanding contact ids recorded on a run. */
export function readPendingContacts(run: Pick<Run, 'metadata'>): string[] {
  const metadata = run.metadata as Record<string, unknown> | undefined
  const raw = metadata?.[PENDING_CONTACTS_KEY]
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string')
}

/** True when `contactId` is an outstanding contact request on `run`. */
export function isPendingContact(
  run: Pick<Run, 'metadata'>,
  contactId: string,
): boolean {
  return readPendingContacts(run).includes(contactId)
}

/**
 * Record `contactId` as outstanding on the run.
 *
 * Idempotent: re-recording the same id leaves the list unchanged.
 */
export async function recordPendingContact(
  runStore: RunStore,
  runId: string,
  contactId: string,
): Promise<void> {
  const run = await runStore.get(runId)
  if (!run) return
  const existing = readPendingContacts(run)
  if (existing.includes(contactId)) return
  const metadata = (run.metadata as Record<string, unknown> | undefined) ?? {}
  await runStore.update(runId, {
    metadata: { ...metadata, [PENDING_CONTACTS_KEY]: [...existing, contactId] },
  })
}

/**
 * Build the metadata patch that removes `contactId` from the outstanding list.
 *
 * Returned rather than written so callers can fold it into the single
 * `runStore.update` they already perform when admitting a response.
 */
export function withoutPendingContact(
  metadata: Record<string, unknown>,
  contactId: string,
): Record<string, unknown> {
  const remaining = readPendingContacts({ metadata } as Pick<Run, 'metadata'>)
    .filter((id) => id !== contactId)
  return { ...metadata, [PENDING_CONTACTS_KEY]: remaining }
}
