/**
 * Versioned Working Memory — typed, persistent structured state with
 * full change history, diff tracking, and revert capability.
 *
 * Every update records a diff and a snapshot, enabling "what changed?"
 * queries and undo to any prior version. History is stored alongside
 * the state in the MemoryService under a dedicated history namespace.
 *
 * @example
 * ```ts
 * const vmem = new VersionedWorkingMemory({
 *   schema: z.object({ stack: z.string(), features: z.array(z.string()).default([]) }),
 *   store: memoryService,
 *   namespace: 'working',
 * })
 *
 * await vmem.load({ tenantId: 't1', projectId: 'p1' })
 * await vmem.update({ tenantId: 't1', projectId: 'p1' }, { stack: 'vue3' }, 'user chose vue3')
 * const history = await vmem.getHistory({ tenantId: 't1', projectId: 'p1' })
 * await vmem.revertTo({ tenantId: 't1', projectId: 'p1' }, 1)
 * ```
 */
import type { z } from 'zod'
import type { MemoryService } from './memory-service.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkingMemoryDiff {
  /** When this change was made */
  timestamp: number
  /** Field-level changes */
  changes: Array<{
    path: string
    oldValue: unknown
    newValue: unknown
  }>
  /** Optional reason for the change */
  reason?: string | undefined
  /** Version number (monotonically increasing) */
  version: number
}

export interface VersionedWorkingMemoryConfig<T extends z.ZodType> {
  /** Zod schema defining the working memory shape */
  schema: T
  /** MemoryService instance for persistence */
  store: MemoryService
  /** Namespace for working memory state */
  namespace: string
  /** Namespace for history records (default: `${namespace}-history`) */
  historyNamespace?: string | undefined
  /** Max history entries to keep (default: 50) */
  maxHistory?: number | undefined
  /** Auto-save after each update (default: true) */
  autoSave?: boolean | undefined
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

function computeDiff(
  oldState: Record<string, unknown>,
  newState: Record<string, unknown>,
): Array<{ path: string; oldValue: unknown; newValue: unknown }> {
  const changes: Array<{ path: string; oldValue: unknown; newValue: unknown }> = []
  const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)])
  for (const key of allKeys) {
    const oldVal = oldState[key]
    const newVal = newState[key]
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ path: key, oldValue: oldVal, newValue: newVal })
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// State metadata (persisted alongside the working state)
// ---------------------------------------------------------------------------

interface StateMeta {
  version: number
  minVersion: number
}

// ---------------------------------------------------------------------------
// VersionedWorkingMemory
// ---------------------------------------------------------------------------

export class VersionedWorkingMemory<T extends z.ZodType> {
  private state: z.infer<T> | null
  private version: number
  private minVersion: number
  private dirty: boolean
  private loaded: boolean
  private readonly config: Required<
    Pick<VersionedWorkingMemoryConfig<T>, 'maxHistory' | 'autoSave'>
  > &
    VersionedWorkingMemoryConfig<T>
  private readonly historyNamespace: string

  constructor(config: VersionedWorkingMemoryConfig<T>) {
    this.config = {
      ...config,
      maxHistory: config.maxHistory ?? 50,
      autoSave: config.autoSave ?? true,
    }
    this.historyNamespace = config.historyNamespace ?? `${config.namespace}-history`
    this.version = 0
    this.minVersion = 0
    this.dirty = false
    this.loaded = false

    // Initialize with schema defaults
    const fromEmpty = config.schema.safeParse({})
    if (fromEmpty.success) {
      this.state = fromEmpty.data as z.infer<T>
    } else {
      const fromUndefined = config.schema.safeParse(undefined)
      this.state = fromUndefined.success ? (fromUndefined.data as z.infer<T>) : null
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Load state and history from store. */
  async load(scope: Record<string, string>): Promise<z.infer<T>> {
    // Load the persisted state + version metadata
    const records = await this.config.store.get(
      this.config.namespace,
      scope,
      'working-state',
    )
    if (records.length > 0) {
      const stored = records[0]
      try {
        const data = stored?.['data'] ?? stored
        this.state = this.config.schema.parse(data) as z.infer<T>
        const meta = stored?.['_versionMeta'] as StateMeta | undefined
        if (meta && typeof meta.version === 'number') {
          this.version = meta.version
          this.minVersion = typeof meta.minVersion === 'number' ? meta.minVersion : 0
        }
      } catch {
        // Invalid stored data — keep defaults
      }
    }

    this.loaded = true
    this.dirty = false
    return this.get()
  }

  /**
   * Get current state (defensive copy).
   * Throws if state has not been initialized.
   */
  get(): z.infer<T> {
    if (this.state === null) {
      throw new Error(
        'VersionedWorkingMemory state is not initialized. ' +
          'Call load() before get() when the schema has required fields without defaults.',
      )
    }
    return structuredClone(this.state)
  }

  /** Update state with a partial merge. Records diff in history. */
  async update(
    scope: Record<string, string>,
    partial: Partial<z.infer<T>>,
    reason?: string,
  ): Promise<z.infer<T>> {
    const oldState = this.state !== null
      ? (structuredClone(this.state) as Record<string, unknown>)
      : {}

    const merged = Object.assign({}, this.state, partial)
    this.state = this.config.schema.parse(merged) as z.infer<T>
    this.dirty = true

    const newVersion = this.version + 1
    const newState = this.state as Record<string, unknown>
    const changes = computeDiff(oldState, newState)

    // Only record history if something actually changed
    if (changes.length > 0) {
      this.version = newVersion

      const diff: WorkingMemoryDiff = {
        timestamp: Date.now(),
        changes,
        version: newVersion,
        ...(reason !== undefined ? { reason } : {}),
      }

      // Persist diff + snapshot (non-fatal)
      try {
        await this.config.store.put(
          this.historyNamespace,
          scope,
          `v-${newVersion}`,
          { text: `Version ${newVersion}: ${reason ?? 'update'}`, ...diff },
        )
        await this.config.store.put(
          this.historyNamespace,
          scope,
          `snap-${newVersion}`,
          { text: `Snapshot at version ${newVersion}`, data: newState, version: newVersion },
        )
      } catch {
        // Non-fatal — history failures must not break state management
      }

      // Prune old history if over limit
      await this.pruneHistory(scope)
    }

    if (this.config.autoSave) {
      await this.save(scope)
    }

    return this.get()
  }

  /** Save current state to the memory store. */
  async save(scope: Record<string, string>): Promise<void> {
    if (!this.dirty) return
    const meta: StateMeta = { version: this.version, minVersion: this.minVersion }
    await this.config.store.put(this.config.namespace, scope, 'working-state', {
      data: this.state,
      text: JSON.stringify(this.state),
      updatedAt: Date.now(),
      _versionMeta: meta,
    })
    this.dirty = false
  }

  /** Get version history, most recent first. */
  async getHistory(
    scope: Record<string, string>,
    limit?: number,
  ): Promise<WorkingMemoryDiff[]> {
    const diffs: WorkingMemoryDiff[] = []
    const effectiveLimit = limit ?? this.config.maxHistory ?? 50
    const startVersion = this.version
    const stopVersion = Math.max(this.minVersion, this.version - effectiveLimit)

    for (let v = startVersion; v > stopVersion; v--) {
      try {
        const records = await this.config.store.get(
          this.historyNamespace,
          scope,
          `v-${v}`,
        )
        if (records.length > 0) {
          const rec = records[0]!
          diffs.push({
            timestamp: rec['timestamp'] as number,
            changes: rec['changes'] as WorkingMemoryDiff['changes'],
            version: rec['version'] as number,
            ...(rec['reason'] !== undefined ? { reason: rec['reason'] as string } : {}),
          })
        }
      } catch {
        // Non-fatal — skip unreadable history entries
      }
    }
    return diffs
  }

  /** Revert to a specific version by loading its snapshot. */
  async revertTo(
    scope: Record<string, string>,
    version: number,
  ): Promise<z.infer<T>> {
    if (version < this.minVersion || version > this.version) {
      throw new Error(
        `Cannot revert to version ${version}. ` +
          `Valid range: ${this.minVersion}..${this.version}`,
      )
    }

    if (version === 0) {
      // Revert to initial state — re-parse schema defaults
      const fromEmpty = this.config.schema.safeParse({})
      if (fromEmpty.success) {
        this.state = fromEmpty.data as z.infer<T>
      } else {
        throw new Error('Cannot revert to version 0: schema has required fields without defaults.')
      }
    } else {
      const records = await this.config.store.get(
        this.historyNamespace,
        scope,
        `snap-${version}`,
      )
      if (records.length === 0) {
        throw new Error(`Snapshot for version ${version} not found.`)
      }
      const data = records[0]?.['data']
      this.state = this.config.schema.parse(data) as z.infer<T>
    }

    // Record the revert as a new version
    const revertVersion = this.version + 1
    const oldState = {} as Record<string, unknown> // diff against empty — full state is "new"
    const newState = this.state as Record<string, unknown>
    const changes = computeDiff(oldState, newState)

    this.version = revertVersion
    this.dirty = true

    const diff: WorkingMemoryDiff = {
      timestamp: Date.now(),
      changes,
      version: revertVersion,
      reason: `Revert to version ${version}`,
    }

    try {
      await this.config.store.put(
        this.historyNamespace,
        scope,
        `v-${revertVersion}`,
        { text: `Version ${revertVersion}: Revert to version ${version}`, ...diff },
      )
      await this.config.store.put(
        this.historyNamespace,
        scope,
        `snap-${revertVersion}`,
        { text: `Snapshot at version ${revertVersion}`, data: newState, version: revertVersion },
      )
    } catch {
      // Non-fatal
    }

    if (this.config.autoSave) {
      await this.save(scope)
    }

    return this.get()
  }

  /** Get diffs between two versions (inclusive range). */
  async diff(
    scope: Record<string, string>,
    fromVersion: number,
    toVersion: number,
  ): Promise<WorkingMemoryDiff[]> {
    if (fromVersion > toVersion) {
      throw new Error(
        `fromVersion (${fromVersion}) must be <= toVersion (${toVersion})`,
      )
    }
    const diffs: WorkingMemoryDiff[] = []
    const lo = Math.max(fromVersion + 1, this.minVersion + 1)
    const hi = Math.min(toVersion, this.version)

    for (let v = lo; v <= hi; v++) {
      try {
        const records = await this.config.store.get(
          this.historyNamespace,
          scope,
          `v-${v}`,
        )
        if (records.length > 0) {
          const rec = records[0]!
          diffs.push({
            timestamp: rec['timestamp'] as number,
            changes: rec['changes'] as WorkingMemoryDiff['changes'],
            version: rec['version'] as number,
            ...(rec['reason'] !== undefined ? { reason: rec['reason'] as string } : {}),
          })
        }
      } catch {
        // Non-fatal
      }
    }
    return diffs
  }

  /** Current version number. */
  get currentVersion(): number {
    return this.version
  }

  /** Format the current state as a markdown block for injection into prompts. */
  toPromptContext(header = '## Working Memory'): string {
    if (this.state === null) return ''
    const json = JSON.stringify(this.state, null, 2)
    return `${header} (v${this.version})\n\`\`\`json\n${json}\n\`\`\``
  }

  /** Check if state has been loaded from store. */
  isLoaded(): boolean {
    return this.loaded
  }

  /** Check if there are unsaved changes. */
  isDirty(): boolean {
    return this.dirty
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Prune history entries that exceed maxHistory.
   * Since MemoryService has no delete, we overwrite old entries with
   * a tombstone and advance minVersion so they are skipped on read.
   */
  private async pruneHistory(scope: Record<string, string>): Promise<void> {
    const overflow = this.version - this.minVersion - (this.config.maxHistory ?? 50)
    if (overflow <= 0) return

    const newMin = this.minVersion + overflow
    for (let v = this.minVersion + 1; v <= newMin; v++) {
      try {
        // Overwrite with tombstone — minimal storage
        await this.config.store.put(
          this.historyNamespace,
          scope,
          `v-${v}`,
          { text: '_pruned', _pruned: true },
        )
        await this.config.store.put(
          this.historyNamespace,
          scope,
          `snap-${v}`,
          { text: '_pruned', _pruned: true },
        )
      } catch {
        // Non-fatal
      }
    }
    this.minVersion = newMin
  }
}
