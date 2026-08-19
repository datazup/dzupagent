import {
  RunStorePendingContactStore,
  type HumanContactPauseContext,
  type HumanContactToolConfig,
  type ResumeTokenProtector,
} from '@dzupagent/agent/tools'
import type { HumanContactRequest } from '@dzupagent/core/tools'
import type { AtomicRunStore } from '@dzupagent/core/persistence'
import type { DzupEventBus } from '@dzupagent/core/events'
import { suspendForPendingContact } from './pending-contacts.js'

export interface DurableHumanContactCompositionOptions {
  runStore: AtomicRunStore
  /** Host-owned token custody. Keys and plaintext tokens never enter metadata. */
  tokenProtector: ResumeTokenProtector
  pauseLeaseMs?: number
  /** Optional content-free lifecycle telemetry sink. */
  eventBus?: DzupEventBus
}

export type DurableHumanContactComposition = Pick<
  HumanContactToolConfig,
  'pendingStore' | 'onPause' | 'pauseLeaseMs'
>

/**
 * Recoverable framework composition for one human-contact tool host.
 *
 * It binds Agent reservation/lease persistence to the same atomic run row used
 * by Server response admission and turns pause acknowledgement into an exact
 * tenant/run/contact/token-bound suspension.
 */
export function createDurableHumanContactComposition(
  options: DurableHumanContactCompositionOptions,
): DurableHumanContactComposition {
  const pendingStore = new RunStorePendingContactStore(
    options.runStore,
    options.tokenProtector,
  )
  const onPause = async (
    contactId: string,
    request: HumanContactRequest,
    context: HumanContactPauseContext,
  ): Promise<void> => {
    if (
      request.contactId !== contactId
      || request.runId !== context.runId
    ) {
      throw new Error('PENDING_CONTACT_BINDING_MISMATCH')
    }
    const suspension = await suspendForPendingContact(options.runStore, {
      contactId,
      runId: context.runId,
      tenantId: context.tenantId,
      resumeToken: context.resumeToken,
    })
    if (suspension === 'suspended') {
      options.eventBus?.emit({
        type: 'human_contact:requested',
        runId: context.runId,
        contactId,
        contactType: request.type,
        channel: request.channel ?? 'in-app',
      })
    }
  }

  return options.pauseLeaseMs === undefined
    ? { pendingStore, onPause }
    : { pendingStore, onPause, pauseLeaseMs: options.pauseLeaseMs }
}
