/**
 * SkillPacks — pre-built skill configurations for common feature types.
 *
 * Provides bootstrap data so a brand-new system starts with curated skills,
 * conventions, and rules rather than zero learned knowledge. Entries are
 * stored in the same namespaces that LessonPipeline, DynamicRuleEngine,
 * and SkillAcquisitionEngine read from, so they integrate seamlessly.
 *
 * Usage:
 *   const loader = new SkillPackLoader(store)
 *   await loader.loadAllBuiltIn()
 *   // Skills, rules, and conventions are now available for retrieval
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillPackEntry {
  type: 'skill' | 'convention' | 'rule'
  content: string
  category?: string
  scope?: string[]
  confidence: number
}

export interface SkillPack {
  id: string
  name: string
  description: string
  featureCategory: string
  version: string
  entries: SkillPackEntry[]
}

// ---------------------------------------------------------------------------
// Built-in packs
// ---------------------------------------------------------------------------

export const BUILT_IN_PACKS: SkillPack[] = [
  {
    id: 'auth-pack-v1',
    name: 'Authentication Pack',
    description: 'Best practices for authentication and session management',
    featureCategory: 'authentication',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Always validate email format and password strength with Zod before processing',
        category: 'validation',
        scope: ['gen_backend', 'auth'],
        confidence: 0.95,
      },
      {
        type: 'skill',
        content: 'Use httpOnly, secure, sameSite cookies for session tokens',
        category: 'security',
        scope: ['gen_backend', 'auth'],
        confidence: 0.95,
      },
      {
        type: 'skill',
        content: 'Implement rate limiting on login/register endpoints (max 5 attempts per minute)',
        category: 'security',
        scope: ['gen_backend', 'auth'],
        confidence: 0.9,
      },
      {
        type: 'rule',
        content: 'Never store plaintext passwords — always use bcrypt or argon2',
        category: 'security',
        scope: ['gen_backend', 'auth'],
        confidence: 1.0,
      },
      {
        type: 'rule',
        content: 'Include CSRF token validation on all state-changing auth endpoints',
        category: 'security',
        scope: ['gen_backend', 'auth'],
        confidence: 0.95,
      },
      {
        type: 'convention',
        content: 'Auth middleware must check token expiration before route handler',
        category: 'architecture',
        scope: ['gen_backend', 'auth'],
        confidence: 0.9,
      },
    ],
  },
  {
    id: 'payments-pack-v1',
    name: 'Payments Pack',
    description: 'Best practices for payment processing and financial operations',
    featureCategory: 'payments',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Validate all monetary amounts as positive integers (cents) to avoid floating point issues',
        category: 'validation',
        scope: ['gen_backend', 'payments'],
        confidence: 0.95,
      },
      {
        type: 'skill',
        content: 'Wrap payment operations in database transactions with rollback on failure',
        category: 'reliability',
        scope: ['gen_backend', 'payments'],
        confidence: 0.95,
      },
      {
        type: 'rule',
        content: 'Never log full credit card numbers — mask all but last 4 digits',
        category: 'security',
        scope: ['gen_backend', 'payments'],
        confidence: 1.0,
      },
      {
        type: 'rule',
        content: 'Always verify webhook signatures before processing payment events',
        category: 'security',
        scope: ['gen_backend', 'payments'],
        confidence: 0.95,
      },
      {
        type: 'convention',
        content: 'Payment routes must require authenticated user with verified email',
        category: 'architecture',
        scope: ['gen_backend', 'payments'],
        confidence: 0.9,
      },
    ],
  },
  {
    id: 'crud-pack-v1',
    name: 'CRUD Pack',
    description: 'Best practices for CRUD API endpoints',
    featureCategory: 'crud',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Use Zod schemas for request body validation with descriptive error messages',
        category: 'validation',
        scope: ['gen_backend', 'crud'],
        confidence: 0.9,
      },
      {
        type: 'skill',
        content: 'Implement cursor-based pagination for list endpoints (not offset)',
        category: 'performance',
        scope: ['gen_backend', 'crud'],
        confidence: 0.85,
      },
      {
        type: 'rule',
        content: 'Always add tenant_id filter to queries in multi-tenant context',
        category: 'security',
        scope: ['gen_backend', 'crud'],
        confidence: 0.95,
      },
      {
        type: 'convention',
        content: 'CRUD routes follow REST conventions: GET /, GET /:id, POST /, PUT /:id, DELETE /:id',
        category: 'architecture',
        scope: ['gen_backend', 'crud'],
        confidence: 0.9,
      },
    ],
  },
  {
    id: 'dashboard-pack-v1',
    name: 'Dashboard Pack',
    description: 'Best practices for dashboard UI components',
    featureCategory: 'dashboard',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Use Pinia stores for dashboard state management with composable API',
        category: 'state',
        scope: ['gen_frontend', 'dashboard'],
        confidence: 0.9,
      },
      {
        type: 'skill',
        content: 'Implement skeleton loading states for all data-fetching components',
        category: 'ux',
        scope: ['gen_frontend', 'dashboard'],
        confidence: 0.85,
      },
      {
        type: 'rule',
        content: 'Dashboard queries must include date range filters to prevent full-table scans',
        category: 'performance',
        scope: ['gen_backend', 'dashboard'],
        confidence: 0.9,
      },
      {
        type: 'convention',
        content: 'Dashboard components use grid layout with responsive breakpoints',
        category: 'layout',
        scope: ['gen_frontend', 'dashboard'],
        confidence: 0.85,
      },
    ],
  },
  {
    id: 'realtime-pack-v1',
    name: 'Realtime Pack',
    description: 'Best practices for WebSocket and real-time communication',
    featureCategory: 'realtime',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Use WebSocket with heartbeat ping/pong to detect stale connections',
        category: 'reliability',
        scope: ['gen_backend', 'realtime'],
        confidence: 0.9,
      },
      {
        type: 'skill',
        content: 'Implement exponential backoff reconnection with max 5 retries',
        category: 'reliability',
        scope: ['gen_frontend', 'realtime'],
        confidence: 0.9,
      },
      {
        type: 'rule',
        content: 'Always validate WebSocket message schema before processing',
        category: 'security',
        scope: ['gen_backend', 'realtime'],
        confidence: 0.95,
      },
      {
        type: 'convention',
        content: 'WebSocket events follow namespace:action format (e.g., chat:message)',
        category: 'architecture',
        scope: ['gen_backend', 'gen_frontend', 'realtime'],
        confidence: 0.85,
      },
    ],
  },
  {
    id: 'file-upload-pack-v1',
    name: 'File Upload Pack',
    description: 'Best practices for file upload handling',
    featureCategory: 'file-upload',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Validate file type via magic bytes, not just extension',
        category: 'security',
        scope: ['gen_backend', 'file-upload'],
        confidence: 0.95,
      },
      {
        type: 'skill',
        content: 'Use pre-signed URLs for direct-to-storage uploads (not through API server)',
        category: 'performance',
        scope: ['gen_backend', 'file-upload'],
        confidence: 0.9,
      },
      {
        type: 'rule',
        content: 'Enforce max file size limits at both client and server level',
        category: 'security',
        scope: ['gen_backend', 'gen_frontend', 'file-upload'],
        confidence: 0.95,
      },
      {
        type: 'convention',
        content: 'Store files with UUID names, preserve original name in metadata',
        category: 'architecture',
        scope: ['gen_backend', 'file-upload'],
        confidence: 0.85,
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Namespace constants — match the default namespaces used by the engines
// ---------------------------------------------------------------------------

const SKILLS_NAMESPACE = ['acquired_skills']
const RULES_NAMESPACE = ['rules']
const CONVENTIONS_NAMESPACE = ['conventions']
const PACKS_META_NAMESPACE = ['skill_packs_meta']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic entry key from pack ID, type, and index */
function entryKey(packId: string, type: string, index: number): string {
  return `${packId}_${type}_${index}`
}

/** Get the target namespace for an entry type */
function namespaceForType(type: 'skill' | 'convention' | 'rule'): string[] {
  switch (type) {
    case 'skill': return SKILLS_NAMESPACE
    case 'rule': return RULES_NAMESPACE
    case 'convention': return CONVENTIONS_NAMESPACE
  }
}

/** Build a skill record compatible with SkillAcquisitionEngine */
function buildSkillRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  return {
    id: key,
    name: entry.content.split(/\s+/).slice(0, 5).join(' '),
    description: entry.content,
    applicableWhen: (entry.scope ?? []).join(', '),
    applicationType: 'prompt_injection',
    content: entry.content,
    evidence: {
      lessonIds: [],
      ruleIds: [],
      successRate: entry.confidence,
      usageCount: 0,
    },
    confidence: entry.confidence,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    source: 'skill_pack',
    packId,
    category: entry.category ?? null,
    text: entry.content,
  }
}

/** Build a rule record compatible with DynamicRuleEngine */
function buildRuleRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  return {
    id: key,
    source: 'convention',
    content: entry.content,
    scope: entry.scope ?? [],
    confidence: entry.confidence,
    applyCount: 0,
    successRate: 1,
    createdAt: new Date().toISOString(),
    lastAppliedAt: null,
    packId,
    category: entry.category ?? null,
    text: entry.content,
  }
}

/** Build a convention record compatible with MemoryIntegrator */
function buildConventionRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  return {
    id: key,
    content: entry.content,
    scope: entry.scope ?? [],
    confidence: entry.confidence,
    createdAt: new Date().toISOString(),
    packId,
    category: entry.category ?? null,
    text: entry.content,
  }
}

/** Build a store record for an entry based on its type */
function buildRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  switch (entry.type) {
    case 'skill': return buildSkillRecord(key, entry, packId)
    case 'rule': return buildRuleRecord(key, entry, packId)
    case 'convention': return buildConventionRecord(key, entry, packId)
  }
}

// ---------------------------------------------------------------------------
// SkillPackLoader
// ---------------------------------------------------------------------------

export class SkillPackLoader {
  private readonly store: BaseStore
  private readonly namespace: string[]

  constructor(store: BaseStore, namespace?: string[]) {
    this.store = store
    this.namespace = namespace ?? []
  }

  /**
   * Load a skill pack into the store. Idempotent — skips if already loaded.
   */
  async loadPack(pack: SkillPack): Promise<{ loaded: number; skipped: number }> {
    const alreadyLoaded = await this.isPackLoaded(pack.id)
    if (alreadyLoaded) {
      return { loaded: 0, skipped: pack.entries.length }
    }

    let loaded = 0

    for (let i = 0; i < pack.entries.length; i++) {
      const entry = pack.entries[i]
      if (!entry) continue

      const key = entryKey(pack.id, entry.type, i)
      const ns = [...this.namespace, ...namespaceForType(entry.type)]
      const record = buildRecord(key, entry, pack.id)

      try {
        await this.store.put(ns, key, record)
        loaded++
      } catch {
        // Non-fatal — continue loading remaining entries
      }
    }

    // Mark pack as loaded
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE]
      await this.store.put(metaNs, pack.id, {
        id: pack.id,
        name: pack.name,
        version: pack.version,
        featureCategory: pack.featureCategory,
        entryCount: pack.entries.length,
        loadedAt: new Date().toISOString(),
        text: `${pack.name} ${pack.description}`,
      })
    } catch {
      // Non-fatal — metadata write failure does not invalidate loaded entries
    }

    return { loaded, skipped: 0 }
  }

  /**
   * Load all built-in packs.
   */
  async loadAllBuiltIn(): Promise<{ packsLoaded: number; totalEntries: number }> {
    let packsLoaded = 0
    let totalEntries = 0

    for (const pack of BUILT_IN_PACKS) {
      const result = await this.loadPack(pack)
      if (result.loaded > 0) {
        packsLoaded++
        totalEntries += result.loaded
      }
    }

    return { packsLoaded, totalEntries }
  }

  /**
   * Check if a pack is already loaded.
   */
  async isPackLoaded(packId: string): Promise<boolean> {
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE]
      const item = await this.store.get(metaNs, packId)
      return item !== undefined && item !== null
    } catch {
      return false
    }
  }

  /**
   * Get list of loaded pack IDs.
   */
  async getLoadedPacks(): Promise<string[]> {
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE]
      const items = await this.store.search(metaNs, { limit: 100 })
      return items
        .map(item => {
          const value = item.value as Record<string, unknown>
          return typeof value['id'] === 'string' ? value['id'] : null
        })
        .filter((id): id is string => id !== null)
    } catch {
      return []
    }
  }

  /**
   * Unload a pack — remove its entries and metadata from the store.
   */
  async unloadPack(packId: string): Promise<number> {
    // Find the pack definition
    const pack = BUILT_IN_PACKS.find(p => p.id === packId)
    let removed = 0

    if (pack) {
      // Remove entries using deterministic keys
      for (let i = 0; i < pack.entries.length; i++) {
        const entry = pack.entries[i]
        if (!entry) continue

        const key = entryKey(packId, entry.type, i)
        const ns = [...this.namespace, ...namespaceForType(entry.type)]

        try {
          await this.store.delete(ns, key)
          removed++
        } catch {
          // Non-fatal
        }
      }
    } else {
      // For custom packs, search across all namespaces for entries tagged with packId
      for (const ns of [SKILLS_NAMESPACE, RULES_NAMESPACE, CONVENTIONS_NAMESPACE]) {
        const fullNs = [...this.namespace, ...ns]
        try {
          const items = await this.store.search(fullNs, { limit: 1000 })
          for (const item of items) {
            const value = item.value as Record<string, unknown>
            if (value['packId'] === packId) {
              await this.store.delete(fullNs, item.key)
              removed++
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }

    // Remove metadata
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE]
      await this.store.delete(metaNs, packId)
    } catch {
      // Non-fatal
    }

    return removed
  }
}
