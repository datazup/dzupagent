/**
 * SessionRegistry — unified session management for multi-turn,
 * multi-provider agent conversations.
 *
 * Maps workflow IDs to provider-specific session IDs, enabling
 * conversation continuity across agent switches and session migration.
 *
 * This module is now a thin coordinator that re-exports the focused
 * sibling modules:
 *   - `session-registry-types.ts`     — public types + lifecycle event union
 *   - `session-registry-store.ts`     — workflow + history `WorkflowStore`
 *   - `session-registry-provider.ts`  — provider-session linking mixin
 *   - `session-registry-core.ts`      — multi-turn execution `SessionRegistry`
 */

export { SessionRegistry } from './session-registry-core.js'
export type {
  ConversationEntry,
  MultiTurnOptions,
  ProviderSession,
  SessionRegistryConfig,
  SessionRegistryEvent,
  WorkflowSession,
} from './session-registry-types.js'
