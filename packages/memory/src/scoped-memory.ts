/**
 * Scoped memory service for multi-agent coordination.
 *
 * Wraps a MemoryService with per-agent access policies, enforcing
 * read/write isolation between agents while allowing controlled sharing.
 *
 * Violations are non-fatal by default (returns empty/void silently).
 * Set `strict: true` to throw on access violations.
 */
import type { MemoryService } from './memory-service.js'
import type { FormatOptions } from './memory-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Access level for a namespace */
export type NamespaceAccess = 'read' | 'write' | 'read-write' | 'none'

/** Per-agent access policy */
export interface MemoryAccessPolicy {
  /** Agent identifier */
  agentId: string
  /** Namespace access rules: namespace name -> access level */
  namespaces: Record<string, NamespaceAccess>
  /** Default access for namespaces not explicitly listed (default: 'none') */
  defaultAccess?: NamespaceAccess | undefined
  /** Tags automatically added to all writes by this agent */
  writeTags?: Record<string, string> | undefined
}

/** Access violation error info (not thrown -- returned for non-fatal handling) */
export interface AccessViolation {
  agentId: string
  namespace: string
  operation: 'read' | 'write'
  requiredAccess: NamespaceAccess
  actualAccess: NamespaceAccess
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEffectiveAccess(
  policy: MemoryAccessPolicy,
  namespace: string,
): NamespaceAccess {
  const explicit = policy.namespaces[namespace]
  if (explicit !== undefined) return explicit
  return policy.defaultAccess ?? 'none'
}

function canRead(access: NamespaceAccess): boolean {
  return access === 'read' || access === 'read-write'
}

function canWrite(access: NamespaceAccess): boolean {
  return access === 'write' || access === 'read-write'
}

// ---------------------------------------------------------------------------
// ScopedMemoryService
// ---------------------------------------------------------------------------

/**
 * Memory service wrapper that enforces per-agent access policies.
 *
 * Wraps a MemoryService and checks access before every operation.
 * Violations are silent by default (returns empty/void) to maintain
 * the non-fatal contract. Set `strict: true` to throw on violations.
 */
export class ScopedMemoryService {
  private readonly violations: AccessViolation[] = []

  constructor(
    private readonly inner: MemoryService,
    private readonly policy: MemoryAccessPolicy,
    private readonly options?: { strict?: boolean },
  ) {}

  /** Get the agent ID for this scoped service */
  get agentId(): string {
    return this.policy.agentId
  }

  // ---- Access checking ----------------------------------------------------

  /** Check if a given operation would be allowed */
  canAccess(namespace: string, operation: 'read' | 'write'): boolean {
    const access = getEffectiveAccess(this.policy, namespace)
    return operation === 'read' ? canRead(access) : canWrite(access)
  }

  /**
   * Check access and record a violation if denied.
   * Returns true if access is allowed, false otherwise.
   * In strict mode, throws instead of returning false.
   */
  private checkAccess(namespace: string, operation: 'read' | 'write'): boolean {
    const access = getEffectiveAccess(this.policy, namespace)
    const allowed = operation === 'read' ? canRead(access) : canWrite(access)

    if (!allowed) {
      const requiredAccess: NamespaceAccess =
        operation === 'read' ? 'read' : 'write'

      const violation: AccessViolation = {
        agentId: this.policy.agentId,
        namespace,
        operation,
        requiredAccess,
        actualAccess: access,
      }
      this.violations.push(violation)

      if (this.options?.strict) {
        throw new Error(
          `ScopedMemory access violation: agent "${violation.agentId}" ` +
          `attempted "${violation.operation}" on namespace "${violation.namespace}" ` +
          `but has "${violation.actualAccess}" access (needs "${violation.requiredAccess}")`,
        )
      }
      return false
    }
    return true
  }

  // ---- Write --------------------------------------------------------------

  /**
   * Store a value -- requires 'write' or 'read-write' access.
   * Automatically enriches value with agent metadata (writeTags).
   */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (!this.checkAccess(namespace, 'write')) return

    const enriched: Record<string, unknown> = {
      ...value,
      _agent: this.policy.agentId,
      ...Object.fromEntries(
        Object.entries(this.policy.writeTags ?? {}).map(
          ([k, v]) => [`_tag_${k}`, v] as const,
        ),
      ),
    }

    await this.inner.put(namespace, scope, key, enriched)
  }

  // ---- Read ---------------------------------------------------------------

  /**
   * Retrieve records -- requires 'read' or 'read-write' access.
   */
  async get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.checkAccess(namespace, 'read')) return []
    return this.inner.get(namespace, scope, key)
  }

  /**
   * Search -- requires 'read' or 'read-write' access.
   */
  async search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    if (!this.checkAccess(namespace, 'read')) return []
    return this.inner.search(namespace, scope, query, limit)
  }

  // ---- Formatting ---------------------------------------------------------

  /** Format records for prompt (delegates to inner, no access check needed) */
  formatForPrompt(
    records: Record<string, unknown>[],
    options?: FormatOptions,
  ): string {
    return this.inner.formatForPrompt(records, options)
  }

  // ---- Violation tracking -------------------------------------------------

  /** Get all access violations recorded so far */
  getViolations(): ReadonlyArray<AccessViolation> {
    return [...this.violations]
  }

  /** Clear recorded violations */
  clearViolations(): void {
    this.violations.length = 0
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create scoped memory services for multiple agents from a shared MemoryService.
 * Convenience function for multi-agent setups.
 */
export function createAgentMemories(
  sharedMemory: MemoryService,
  policies: MemoryAccessPolicy[],
  options?: { strict?: boolean },
): Map<string, ScopedMemoryService> {
  const map = new Map<string, ScopedMemoryService>()
  for (const policy of policies) {
    map.set(policy.agentId, new ScopedMemoryService(sharedMemory, policy, options))
  }
  return map
}

// ---------------------------------------------------------------------------
// Policy Templates
// ---------------------------------------------------------------------------

/**
 * Pre-built policy templates for common patterns.
 */
export const PolicyTemplates = {
  /** Full read-write access to all namespaces */
  fullAccess(agentId: string): MemoryAccessPolicy {
    return { agentId, namespaces: {}, defaultAccess: 'read-write' }
  },

  /** Read-only access to all namespaces */
  readOnly(agentId: string): MemoryAccessPolicy {
    return { agentId, namespaces: {}, defaultAccess: 'read' }
  },

  /** Read-write to own namespaces, read-only to shared */
  isolatedWithSharedRead(
    agentId: string,
    ownNamespaces: string[],
    sharedNamespaces: string[],
  ): MemoryAccessPolicy {
    return {
      agentId,
      namespaces: {
        ...Object.fromEntries(ownNamespaces.map(ns => [ns, 'read-write' as const])),
        ...Object.fromEntries(sharedNamespaces.map(ns => [ns, 'read' as const])),
      },
      defaultAccess: 'none',
    }
  },

  /** Read-write to specific namespaces, none to everything else */
  restricted(
    agentId: string,
    allowedNamespaces: Record<string, NamespaceAccess>,
  ): MemoryAccessPolicy {
    return {
      agentId,
      namespaces: { ...allowedNamespaces },
      defaultAccess: 'none',
    }
  },
} as const
