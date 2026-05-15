/**
 * VersionedContextBackend — unified promotion-aware context store.
 *
 * Consolidates the two existing versioned stores into one abstraction:
 *   - versioned working memory (packages/memory/src/versioned-working-memory.ts)
 *   - versioned skill projections (packages/agent-adapters/src/skills/adapter-skill-version-store.ts)
 *
 * Adds promotion semantics: artifacts live in one of three stages
 * (dev → staging → prod) and can be promoted explicitly. This prevents
 * accidental prompt/skill drift and enables benchmark-gated rollouts.
 *
 * Artifact kinds:
 *   'prompt'   — system prompt templates or prompt fragments
 *   'skill'    — agent skill definitions (tool descriptors + handlers)
 *   'memory'   — persistent agent memory records
 *   'policy'   — governance/approval policy configurations
 *
 * Storage: in-memory with stage-aware namespacing. Replace the internal
 * `store` with a Drizzle/Redis backend for durable multi-tenant use.
 */

// ---------------------------------------------------------------------------
// Stage and kind
// ---------------------------------------------------------------------------

/** Promotion stage for context artifacts. */
export type ContextStage = 'dev' | 'staging' | 'prod'

/** Artifact kind determines validation rules and consumer expectations. */
export type ContextKind = 'prompt' | 'skill' | 'memory' | 'policy'

// ---------------------------------------------------------------------------
// Artifact types
// ---------------------------------------------------------------------------

/**
 * A versioned, stage-aware context artifact stored in the backend.
 */
export interface ContextArtifact<T = unknown> {
  /** Unique artifact identifier within its kind+tenantId namespace. */
  artifactId: string
  /** Artifact category. */
  kind: ContextKind
  /** Tenant scope (required — no cross-tenant bleed). */
  tenantId: string
  /** Semantic version of this artifact's content. */
  version: string
  /** Current promotion stage. */
  stage: ContextStage
  /** The artifact payload. */
  content: T
  /** Optional human-readable description. */
  description?: string
  /**
   * Benchmark run ID that validated this artifact for promotion.
   * Enforced as a prerequisite when `requireBenchmark: true` is passed
   * to `promote()`.
   */
  benchmarkId?: string
  /** Wall-clock time of last modification (ms since epoch). */
  updatedAt: number
  /** Wall-clock time this artifact was first created (ms since epoch). */
  createdAt: number
}

/** Query filter for listing artifacts. */
export interface ContextArtifactQuery {
  tenantId: string
  kind?: ContextKind
  stage?: ContextStage
  /** Substring match on artifactId. */
  idContains?: string
}

/** Promotion options. */
export interface PromoteOptions {
  /**
   * When true, `promote()` throws if the artifact has no `benchmarkId`
   * (enforces eval-gated promotion).
   */
  requireBenchmark?: boolean
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface VersionedContextBackend {
  /** Upsert an artifact. `version` is caller-supplied semver. */
  put<T>(artifact: Omit<ContextArtifact<T>, 'createdAt' | 'updatedAt'>): Promise<void>

  /** Retrieve an artifact by kind + tenantId + artifactId + stage. */
  get<T>(params: {
    kind: ContextKind
    tenantId: string
    artifactId: string
    stage: ContextStage
  }): Promise<ContextArtifact<T> | undefined>

  /** List artifacts matching the query. */
  list<T>(query: ContextArtifactQuery): Promise<ContextArtifact<T>[]>

  /**
   * Promote an artifact from its current stage to the next stage
   * (dev → staging → prod). Throws if already at `prod` or if
   * `requireBenchmark` is set and the artifact has no benchmarkId.
   */
  promote(params: {
    kind: ContextKind
    tenantId: string
    artifactId: string
    fromStage: ContextStage
    options?: PromoteOptions
  }): Promise<ContextArtifact>

  /** Hard-delete an artifact at a specific stage. */
  delete(params: {
    kind: ContextKind
    tenantId: string
    artifactId: string
    stage: ContextStage
  }): Promise<void>
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * In-memory VersionedContextBackend.
 *
 * Artifacts are keyed by `${kind}:${tenantId}:${artifactId}:${stage}`.
 * Suitable for tests and single-process deployments.
 */
export class InMemoryVersionedContextBackend implements VersionedContextBackend {
  private readonly store = new Map<string, ContextArtifact>()

  async put<T>(artifact: Omit<ContextArtifact<T>, 'createdAt' | 'updatedAt'>): Promise<void> {
    const key = this.key(artifact.kind, artifact.tenantId, artifact.artifactId, artifact.stage)
    const existing = this.store.get(key)
    const now = Date.now()
    this.store.set(key, {
      ...artifact,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as ContextArtifact)
  }

  async get<T>(params: {
    kind: ContextKind
    tenantId: string
    artifactId: string
    stage: ContextStage
  }): Promise<ContextArtifact<T> | undefined> {
    const key = this.key(params.kind, params.tenantId, params.artifactId, params.stage)
    return this.store.get(key) as ContextArtifact<T> | undefined
  }

  async list<T>(query: ContextArtifactQuery): Promise<ContextArtifact<T>[]> {
    const results: ContextArtifact<T>[] = []
    for (const artifact of this.store.values()) {
      if (artifact.tenantId !== query.tenantId) continue
      if (query.kind && artifact.kind !== query.kind) continue
      if (query.stage && artifact.stage !== query.stage) continue
      if (query.idContains && !artifact.artifactId.includes(query.idContains)) continue
      results.push(artifact as ContextArtifact<T>)
    }
    return results
  }

  async promote(params: {
    kind: ContextKind
    tenantId: string
    artifactId: string
    fromStage: ContextStage
    options?: PromoteOptions
  }): Promise<ContextArtifact> {
    const { kind, tenantId, artifactId, fromStage, options } = params
    const nextStage = PROMOTION_PATH[fromStage]
    if (!nextStage) {
      throw new Error(`Cannot promote from stage '${fromStage}' — already at production.`)
    }

    const sourceKey = this.key(kind, tenantId, artifactId, fromStage)
    const source = this.store.get(sourceKey)
    if (!source) {
      throw new Error(`Artifact not found: ${kind}/${tenantId}/${artifactId}@${fromStage}`)
    }

    if (options?.requireBenchmark && !source.benchmarkId) {
      throw new Error(
        `Promotion of '${artifactId}' to '${nextStage}' requires a benchmarkId — run evals first.`,
      )
    }

    const destKey = this.key(kind, tenantId, artifactId, nextStage)
    const now = Date.now()
    const promoted: ContextArtifact = {
      ...source,
      stage: nextStage,
      updatedAt: now,
    }
    this.store.set(destKey, promoted)
    return promoted
  }

  async delete(params: {
    kind: ContextKind
    tenantId: string
    artifactId: string
    stage: ContextStage
  }): Promise<void> {
    const key = this.key(params.kind, params.tenantId, params.artifactId, params.stage)
    this.store.delete(key)
  }

  /** Test/ops helper: total number of stored artifacts. */
  get size(): number {
    return this.store.size
  }

  private key(kind: ContextKind, tenantId: string, artifactId: string, stage: ContextStage): string {
    return `${kind}:${tenantId}:${artifactId}:${stage}`
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROMOTION_PATH: Partial<Record<ContextStage, ContextStage>> = {
  dev: 'staging',
  staging: 'prod',
}
