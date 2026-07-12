/**
 * SessionRegistry — public types and event union.
 *
 * Pure type definitions used by the registry coordinator and its sibling
 * modules (store, provider, core). Re-exported from `./session-registry.ts`.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { ConversationCompressorOptions } from './conversation-compressor.js'
import type { AdapterProviderId } from '../types.js'

export interface ProviderSession {
  providerId: AdapterProviderId
  /** Provider-specific session identifier (e.g. Claude session_id, Codex thread_id) */
  sessionId: string
  createdAt: Date
  lastActiveAt: Date
  turnCount: number
  totalTokens: { input: number; output: number }
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system'
  content: string
  providerId: AdapterProviderId
  timestamp: Date
  turnIndex: number
}

export interface WorkflowSession {
  workflowId: string
  createdAt: Date
  lastActiveAt: Date
  /** Provider sessions linked to this workflow */
  providerSessions: Map<AdapterProviderId, ProviderSession>
  /** Conversation history entries (provider-agnostic) */
  conversationHistory: ConversationEntry[]
  /** Metadata for the workflow */
  metadata: Record<string, unknown>
  /** Current active provider */
  activeProvider?: AdapterProviderId | undefined
}

export interface SessionRegistryConfig {
  eventBus?: DzupEventBus | undefined
  /** Max conversation history entries to keep per workflow. Default 100 */
  maxHistoryEntries?: number | undefined
  /** TTL for inactive sessions in ms. Default: 1 hour */
  sessionTtlMs?: number | undefined
  /** Options for per-workflow conversation compressors (token budget, etc.) */
  compressorOptions?: ConversationCompressorOptions | undefined
}

export interface MultiTurnOptions {
  /** The workflow to continue */
  workflowId: string
  /** Which provider to use for the next turn */
  provider?: AdapterProviderId | undefined
  /** Explicit legacy cross-provider fallback authorization. */
  approvedFallbackProviders?: AdapterProviderId[] | undefined
  /** Whether to include conversation history as context */
  includeHistory?: boolean | undefined
  /** Max history entries to include in context. Default 10 */
  maxContextEntries?: number | undefined
}

/** Discriminated union of session registry lifecycle events. */
export type SessionRegistryEvent =
  | { type: 'session:workflow_created'; workflowId: string }
  | { type: 'session:workflow_deleted'; workflowId: string }
  | {
      type: 'session:provider_linked'
      workflowId: string
      providerId: AdapterProviderId
      sessionId: string
    }
  | {
      type: 'session:provider_switched'
      workflowId: string
      from: AdapterProviderId | undefined
      to: AdapterProviderId
    }
  | {
      type: 'session:multi_turn_completed'
      workflowId: string
      providerId: AdapterProviderId | undefined
      durationMs: number
    }
  | { type: 'session:pruned'; count: number }
