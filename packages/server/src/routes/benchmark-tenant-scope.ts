/**
 * Tenant scoping helpers for benchmark routes (DZUPAGENT-SEC-H-01).
 *
 * The shared `BenchmarkRunRecord` / `BenchmarkRunStore` / `BenchmarkOrchestratorLike`
 * contracts live in `@dzupagent/eval-contracts` and intentionally do NOT carry a
 * `tenantId` field — those interfaces are consumed by both the framework
 * runtime (`@dzupagent/evals`) and the server, so we cannot extend them
 * unilaterally here.
 *
 * Instead, the server stores tenant ownership in `BenchmarkRunRecord.metadata`
 * (as `metadata.tenantId`) and `BenchmarkBaselineRecord` ownership is implied
 * by the matching tenant-stamped run. Reads, writes, and baseline mutations
 * are all filtered through the helpers in this module so cross-tenant access
 * is impossible at the route layer.
 */
import type {
  BenchmarkBaselineRecord,
  BenchmarkOrchestratorLike,
  BenchmarkRunArtifactRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkRunRecord,
  BenchmarkRunStore,
} from '@dzupagent/eval-contracts'

/**
 * Internal metadata key used to stamp tenant ownership onto benchmark records.
 * Lives in `metadata.tenantId` per the project-wide convention (see
 * `run-stages-persistence.ts` and `run-worker.ts`).
 */
export const TENANT_METADATA_KEY = 'tenantId'

export function getRecordTenantId(record: { metadata?: Record<string, unknown> | undefined } | null | undefined): string | undefined {
  if (!record || !record.metadata) return undefined
  const raw = record.metadata[TENANT_METADATA_KEY]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export function stampTenantMetadata(
  tenantId: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // Server-side stamp always wins so clients cannot spoof a different tenant.
  return { ...(metadata ?? {}), [TENANT_METADATA_KEY]: tenantId }
}

export function recordBelongsToTenant(
  record: { metadata?: Record<string, unknown> | undefined } | null | undefined,
  tenantId: string,
): boolean {
  if (!record) return false
  return getRecordTenantId(record) === tenantId
}

/**
 * Filter a list of records to only those owned by `tenantId`.
 */
export function filterRecordsByTenant<T extends { metadata?: Record<string, unknown> | undefined }>(
  records: readonly T[],
  tenantId: string,
): T[] {
  return records.filter((r) => recordBelongsToTenant(r, tenantId))
}

/**
 * Look up the tenant-stamped run referenced by a baseline. Returns the run only
 * when its tenant stamp matches the requesting tenant.
 */
export async function getBaselineOwnerTenant(
  store: BenchmarkRunStore,
  baseline: BenchmarkBaselineRecord,
): Promise<string | undefined> {
  const run = await store.getRun(baseline.runId)
  return getRecordTenantId(run ?? undefined)
}

export interface TenantScopedOrchestratorOptions {
  orchestrator: BenchmarkOrchestratorLike
  store: BenchmarkRunStore
  tenantId: string
}

/**
 * Per-request tenant-scoped facade over a `BenchmarkOrchestratorLike`.
 *
 * - `runSuite` forces `metadata.tenantId` to the requesting tenant (a spoofed
 *   `metadata.tenantId` in the request body is silently overridden).
 * - `getRun` / `listRuns` / `compareRuns` / `getBaseline` / `listBaselines`
 *   return 404 (`getRun` -> null) for cross-tenant rows so existence is not
 *   leaked.
 * - `setBaseline` rejects setting a baseline that points to another tenant's
 *   run.
 */
export class TenantScopedBenchmarkOrchestrator {
  constructor(private readonly opts: TenantScopedOrchestratorOptions) {}

  async runSuite(input: {
    suiteId: string
    targetId: string
    strict?: boolean | undefined
    metadata?: Record<string, unknown> | undefined
    artifact?: BenchmarkRunArtifactRecord | undefined
  }): Promise<BenchmarkRunRecord> {
    const stampedMetadata = stampTenantMetadata(this.opts.tenantId, input.metadata)
    const callInput: Parameters<BenchmarkOrchestratorLike['runSuite']>[0] = {
      suiteId: input.suiteId,
      targetId: input.targetId,
      ...(input.strict !== undefined ? { strict: input.strict } : {}),
      metadata: stampedMetadata,
      ...(input.artifact ? { artifact: input.artifact } : {}),
    }
    return this.opts.orchestrator.runSuite(callInput)
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    const run = await this.opts.orchestrator.getRun(runId)
    if (!run) return null
    if (!recordBelongsToTenant(run, this.opts.tenantId)) return null
    return run
  }

  async listRuns(filter?: BenchmarkRunListFilter): Promise<BenchmarkRunListPage> {
    // Pagination is handled by the underlying store. We over-fetch by walking
    // forward through the cursor until we accumulate a full page of tenant
    // rows, or exhaust the data. This preserves the public `nextCursor` /
    // `hasMore` shape callers expect.
    const requestedLimit = Math.max(1, filter?.limit ?? 50)
    const safetyBudget = 25
    const owned: BenchmarkRunRecord[] = []
    let cursor = filter?.cursor
    let lastPage: BenchmarkRunListPage | null = null

    for (let i = 0; i < safetyBudget && owned.length < requestedLimit; i++) {
      const innerFilter: BenchmarkRunListFilter = {
        ...(filter?.suiteId ? { suiteId: filter.suiteId } : {}),
        ...(filter?.targetId ? { targetId: filter.targetId } : {}),
        limit: requestedLimit,
        ...(cursor ? { cursor } : {}),
      }
      const page = await this.opts.orchestrator.listRuns(innerFilter)
      lastPage = page
      for (const run of page.data) {
        if (recordBelongsToTenant(run, this.opts.tenantId)) {
          owned.push(run)
          if (owned.length >= requestedLimit) break
        }
      }
      if (!page.hasMore || page.nextCursor === null) break
      cursor = page.nextCursor
    }

    const hasMore = lastPage?.hasMore === true && owned.length >= requestedLimit
    const data = owned.slice(0, requestedLimit)
    let nextCursor: string | null = null
    if (hasMore) {
      // Use the cursor reported by the last inner page; subsequent reads will
      // continue past any non-tenant rows transparently.
      nextCursor = lastPage?.nextCursor ?? null
    }
    return { data, hasMore, nextCursor }
  }

  async compareRuns(currentRunId: string, previousRunId: string): Promise<
    Awaited<ReturnType<BenchmarkOrchestratorLike['compareRuns']>>
  > {
    // Validate ownership of both runs before delegating to the orchestrator so
    // we never leak existence of a cross-tenant run via the comparison error.
    const [currentRun, previousRun] = await Promise.all([
      this.opts.store.getRun(currentRunId),
      this.opts.store.getRun(previousRunId),
    ])
    if (!currentRun || !recordBelongsToTenant(currentRun, this.opts.tenantId)) {
      throw new Error(`Current run "${currentRunId}" not found`)
    }
    if (!previousRun || !recordBelongsToTenant(previousRun, this.opts.tenantId)) {
      throw new Error(`Previous run "${previousRunId}" not found`)
    }
    return this.opts.orchestrator.compareRuns(currentRunId, previousRunId)
  }

  async setBaseline(input: {
    suiteId: string
    targetId: string
    runId: string
  }): Promise<BenchmarkBaselineRecord> {
    const run = await this.opts.store.getRun(input.runId)
    if (!run || !recordBelongsToTenant(run, this.opts.tenantId)) {
      // 404-equivalent: do not leak existence of a cross-tenant run.
      throw new Error(`Run "${input.runId}" not found`)
    }
    return this.opts.orchestrator.setBaseline(input)
  }

  async getBaseline(suiteId: string, targetId: string): Promise<BenchmarkBaselineRecord | null> {
    const baseline = await this.opts.orchestrator.getBaseline(suiteId, targetId)
    if (!baseline) return null
    const ownerTenant = await getBaselineOwnerTenant(this.opts.store, baseline)
    if (ownerTenant !== this.opts.tenantId) return null
    return baseline
  }

  async listBaselines(filter?: { suiteId?: string | undefined; targetId?: string | undefined }): Promise<BenchmarkBaselineRecord[]> {
    const baselines = await this.opts.orchestrator.listBaselines(filter)
    if (baselines.length === 0) return baselines
    // For each baseline, only include it if the referenced run belongs to the
    // requesting tenant. Done concurrently to keep p99 reasonable.
    const owned = await Promise.all(
      baselines.map(async (b) => ({
        baseline: b,
        ownerTenant: await getBaselineOwnerTenant(this.opts.store, b),
      })),
    )
    return owned
      .filter((entry) => entry.ownerTenant === this.opts.tenantId)
      .map((entry) => entry.baseline)
  }
}
