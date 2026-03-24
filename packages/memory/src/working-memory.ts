/**
 * Working memory — typed, persistent structured state across sessions.
 *
 * Unlike MemoryService (free-form key-value), WorkingMemory enforces a
 * Zod schema on the stored state. Reads/writes go through validation,
 * ensuring the persisted state always conforms to the schema.
 *
 * @example
 * ```ts
 * const memory = new WorkingMemory({
 *   schema: z.object({
 *     preferredStack: z.string().optional(),
 *     completedFeatures: z.array(z.string()).default([]),
 *   }),
 *   store: memoryService,
 *   namespace: 'working',
 * })
 *
 * await memory.load({ tenantId: 't1', projectId: 'p1' })
 * await memory.update({ tenantId: 't1', projectId: 'p1' }, { preferredStack: 'vue3' })
 * const state = memory.get() // typed
 * ```
 */
import type { z } from 'zod'
import type { MemoryService } from './memory-service.js'

export interface WorkingMemoryConfig<T extends z.ZodType> {
  /** Zod schema defining the working memory shape */
  schema: T
  /** MemoryService instance for persistence */
  store: MemoryService
  /** Namespace in the memory service */
  namespace: string
  /** Auto-save after each update (default: true) */
  autoSave?: boolean
}

export class WorkingMemory<T extends z.ZodType> {
  private state: z.infer<T>
  private dirty = false
  private loaded = false
  private readonly config: WorkingMemoryConfig<T>

  constructor(config: WorkingMemoryConfig<T>) {
    this.config = config
    // Initialize with schema defaults (parse empty object)
    try {
      this.state = config.schema.parse({}) as z.infer<T>
    } catch {
      // Schema might not accept empty object — use undefined-like state
      this.state = {} as z.infer<T>
    }
  }

  /** Load state from the memory store */
  async load(scope: Record<string, string>): Promise<z.infer<T>> {
    const records = await this.config.store.get(this.config.namespace, scope, 'working-state')
    if (records.length > 0) {
      const stored = records[0]
      try {
        // Merge stored data with schema defaults (handles new fields)
        const data = stored?.['data'] ?? stored
        this.state = this.config.schema.parse(data) as z.infer<T>
      } catch {
        // Invalid stored data — keep defaults
      }
    }
    this.loaded = true
    this.dirty = false
    return this.get()
  }

  /** Get current state (returns a defensive copy) */
  get(): z.infer<T> {
    return structuredClone(this.state)
  }

  /** Update state with a partial merge */
  async update(
    scope: Record<string, string>,
    partial: Partial<z.infer<T>>,
  ): Promise<z.infer<T>> {
    const merged = Object.assign({}, this.state, partial)
    this.state = this.config.schema.parse(merged) as z.infer<T>
    this.dirty = true

    if (this.config.autoSave !== false) {
      await this.save(scope)
    }

    return this.get()
  }

  /** Persist current state to the memory store */
  async save(scope: Record<string, string>): Promise<void> {
    if (!this.dirty) return
    await this.config.store.put(
      this.config.namespace,
      scope,
      'working-state',
      { data: this.state, text: JSON.stringify(this.state), updatedAt: Date.now() },
    )
    this.dirty = false
  }

  /** Format the current state as a markdown block for injection into prompts */
  toPromptContext(header = '## Working Memory'): string {
    const json = JSON.stringify(this.state, null, 2)
    return `${header}\n\`\`\`json\n${json}\n\`\`\``
  }

  /** Check if state has been loaded from store */
  isLoaded(): boolean {
    return this.loaded
  }

  /** Check if there are unsaved changes */
  isDirty(): boolean {
    return this.dirty
  }
}
