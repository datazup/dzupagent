/**
 * Inter-agent mailbox config types for {@link DzupAgentConfig.mailbox}.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */
import type { DzupEventBus } from '@dzupagent/core/events'
import type { MailboxStore } from '../mailbox/types.js'

/** Configuration for enabling the inter-agent mailbox on a DzupAgent. */
export interface AgentMailboxConfig {
  /** Backing store for mail messages. Defaults to InMemoryMailboxStore. */
  store?: MailboxStore
  /** Event bus for real-time mail notifications. Falls back to the agent's own eventBus. */
  eventBus?: DzupEventBus
}
