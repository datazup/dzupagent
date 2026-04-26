/**
 * Shared types, constants, and imports for A2A route modules.
 */
import type { Context } from 'hono'
import type { AgentCard } from '../../a2a/agent-card.js'
import type { A2ATaskStore } from '../../a2a/task-handler.js'
import type { A2ATask } from '../../a2a/task-handler.js'

export interface A2ARoutesConfig {
  agentCard: AgentCard
  taskStore: A2ATaskStore
  /** Called after a task is created so the host can start execution. */
  onTaskSubmitted?: (task: A2ATask) => Promise<void>
  /** Called when a multi-turn task receives additional input. */
  onTaskContinued?: (task: A2ATask) => Promise<void>
}

/** Known A2A JSON-RPC methods. */
export const A2A_METHODS = new Set([
  'tasks/send',
  'tasks/get',
  'tasks/cancel',
  'tasks/sendSubscribe',
  'tasks/pushNotification/set',
  'tasks/pushNotification/get',
  'tasks/resubscribe',
])

// ---------------------------------------------------------------------------
// RF-SEC-05: caller scope helpers
// ---------------------------------------------------------------------------

/**
 * Authenticated caller scope extracted from the Hono context. When the auth
 * middleware is disabled (`apiKey` absent), both fields are `undefined` and
 * route handlers MUST treat the request as un-scoped — preserving the legacy
 * single-tenant default.
 */
export interface A2ACallerScope {
  ownerId: string | undefined
  tenantId: string | undefined
}

/**
 * Pull the caller scope out of the Hono context. Mirrors the pattern in
 * routes/runs.ts so A2A and run routes share a single owner/tenant model.
 *
 * - `ownerId`   — the API key's `id` field (used for cross-owner 404s).
 * - `tenantId`  — `tenantId` from the key, falling back to `ownerId` then
 *                  `id`, then `'default'`. Only emitted when an apiKey
 *                  context is present so library-default deployments behave
 *                  unchanged.
 */
export function getCallerScope(c: Context): A2ACallerScope {
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  if (!key) return { ownerId: undefined, tenantId: undefined }

  const id = typeof key['id'] === 'string' ? (key['id'] as string) : undefined

  const tenantRaw = key['tenantId']
  const ownerFallback = key['ownerId']
  const tenantId =
    typeof tenantRaw === 'string' && tenantRaw.length > 0
      ? tenantRaw
      : typeof ownerFallback === 'string' && ownerFallback.length > 0
        ? ownerFallback
        : id ?? 'default'

  return { ownerId: id, tenantId }
}

/**
 * Returns true when the caller is allowed to read/mutate `task`. A run with
 * no recorded `ownerId` is always visible (pre-migration data); when the
 * caller is unauthenticated (no apiKey context) every task is visible.
 *
 * Tenant mismatch is treated as not-found to avoid existence enumeration.
 */
export function callerOwnsTask(scope: A2ACallerScope, task: A2ATask): boolean {
  // Unauthenticated single-tenant default — no scoping.
  if (scope.ownerId === undefined && scope.tenantId === undefined) return true

  // Owner check. Pre-migration tasks (ownerId === null/undefined) stay
  // accessible so legacy data does not silently disappear.
  if (
    task.ownerId !== undefined
    && task.ownerId !== null
    && scope.ownerId !== undefined
    && task.ownerId !== scope.ownerId
  ) {
    return false
  }

  // Tenant check. Pre-migration tasks default to 'default'.
  if (scope.tenantId !== undefined) {
    const taskTenant = task.tenantId ?? 'default'
    if (taskTenant !== scope.tenantId) return false
  }

  return true
}
