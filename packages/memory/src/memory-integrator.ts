/**
 * Memory Integrator — prepares enriched memory context for pipeline nodes.
 *
 * Reads lessons, conventions, and past error patterns from a BaseStore
 * (written by LessonPipeline and other memory writers) and formats them
 * as a system prompt section for prompt-augmented generation.
 *
 * This is a read-only module — it does not write to the store.
 *
 * Usage:
 *   const integrator = new MemoryIntegrator({ store })
 *   const section = await integrator.getPromptSection({ nodeId: 'gen_backend' })
 *   // Inject `section` into the system prompt
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Formatted memory context ready for prompt injection */
export interface MemoryContext {
  /** Formatted lessons from past runs */
  lessons: string
  /** Formatted conventions */
  conventions: string
  /** Formatted past error warnings */
  warnings: string
  /** Total number of memory items retrieved */
  totalItems: number
}

export interface MemoryIntegratorConfig {
  /** LangGraph BaseStore for memory access */
  store: BaseStore
  /** Namespace prefix for lessons (default: ['lessons']) */
  lessonsNamespace?: string[]
  /** Namespace prefix for conventions (default: ['conventions']) */
  conventionsNamespace?: string[]
  /** Namespace prefix for errors (default: ['errors']) */
  errorsNamespace?: string[]
  /** Max lessons to retrieve per context (default: 5) */
  maxLessons?: number
  /** Max conventions to retrieve (default: 10) */
  maxConventions?: number
  /** Max past errors to retrieve (default: 3) */
  maxErrors?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoreItem {
  key: string
  value: Record<string, unknown>
}

/**
 * Safely search a BaseStore namespace, returning an empty array on failure.
 */
async function safeSearch(
  store: BaseStore,
  namespace: string[],
  limit: number,
): Promise<StoreItem[]> {
  try {
    const results = await store.search(namespace, { limit })
    return results as StoreItem[]
  } catch {
    return []
  }
}

/**
 * Check if a record matches any of the given filter terms.
 * Searches in summary, details, text, applicableContext, nodeId, and id fields.
 */
function matchesFilter(
  value: Record<string, unknown>,
  filters: string[],
): boolean {
  if (filters.length === 0) return true

  const searchable = [
    typeof value['summary'] === 'string' ? value['summary'] : '',
    typeof value['details'] === 'string' ? value['details'] : '',
    typeof value['text'] === 'string' ? value['text'] : '',
    typeof value['description'] === 'string' ? value['description'] : '',
    typeof value['name'] === 'string' ? value['name'] : '',
    typeof value['id'] === 'string' ? value['id'] : '',
    typeof value['nodeId'] === 'string' ? value['nodeId'] : '',
    typeof value['errorType'] === 'string' ? value['errorType'] : '',
  ]
    .join(' ')
    .toLowerCase()

  // Also check applicableContext array
  const ctx = Array.isArray(value['applicableContext'])
    ? (value['applicableContext'] as unknown[]).map(c => String(c).toLowerCase()).join(' ')
    : ''

  const combined = `${searchable} ${ctx}`

  return filters.some(f => combined.includes(f.toLowerCase()))
}

// ---------------------------------------------------------------------------
// MemoryIntegrator
// ---------------------------------------------------------------------------

export class MemoryIntegrator {
  private readonly store: BaseStore
  private readonly lessonsNamespace: string[]
  private readonly conventionsNamespace: string[]
  private readonly errorsNamespace: string[]
  private readonly maxLessons: number
  private readonly maxConventions: number
  private readonly maxErrors: number

  constructor(config: MemoryIntegratorConfig) {
    this.store = config.store
    this.lessonsNamespace = config.lessonsNamespace ?? ['lessons']
    this.conventionsNamespace = config.conventionsNamespace ?? ['conventions']
    this.errorsNamespace = config.errorsNamespace ?? ['errors']
    this.maxLessons = config.maxLessons ?? 5
    this.maxConventions = config.maxConventions ?? 10
    this.maxErrors = config.maxErrors ?? 3
  }

  /**
   * Prepare memory context for a pipeline node.
   * Retrieves relevant lessons, conventions, and past error patterns.
   * All retrievals are best-effort — failures return empty sections.
   */
  async prepareContext(params: {
    nodeId?: string
    taskType?: string
    errorType?: string
  }): Promise<MemoryContext> {
    const filters: string[] = []
    if (params.nodeId) filters.push(params.nodeId)
    if (params.taskType) filters.push(params.taskType)
    if (params.errorType) filters.push(params.errorType)

    // Fetch extra to allow filtering, then trim to max
    const fetchMultiplier = 3

    const [rawLessons, rawConventions, rawErrors] = await Promise.all([
      safeSearch(this.store, this.lessonsNamespace, this.maxLessons * fetchMultiplier),
      safeSearch(this.store, this.conventionsNamespace, this.maxConventions * fetchMultiplier),
      safeSearch(this.store, this.errorsNamespace, this.maxErrors * fetchMultiplier),
    ])

    // Filter lessons by context match
    const filteredLessons = (filters.length > 0
      ? rawLessons.filter(item => matchesFilter(item.value, filters))
      : rawLessons
    ).slice(0, this.maxLessons)

    // Conventions are generally not filtered by nodeId — return all
    const filteredConventions = rawConventions
      .filter(item => !item.value['_deleted'])
      .slice(0, this.maxConventions)

    // Filter errors by nodeId or errorType
    const errorFilters: string[] = []
    if (params.nodeId) errorFilters.push(params.nodeId)
    if (params.errorType) errorFilters.push(params.errorType)

    const filteredErrors = (errorFilters.length > 0
      ? rawErrors.filter(item => matchesFilter(item.value, errorFilters))
      : rawErrors
    ).slice(0, this.maxErrors)

    // Format sections
    const lessons = this.formatLessons(filteredLessons)
    const conventions = this.formatConventions(filteredConventions)
    const warnings = this.formatWarnings(filteredErrors)

    const totalItems = filteredLessons.length + filteredConventions.length + filteredErrors.length

    return { lessons, conventions, warnings, totalItems }
  }

  /**
   * Format a MemoryContext as a system prompt section.
   * Returns empty string if no memory items found.
   */
  formatAsPromptSection(ctx: MemoryContext): string {
    if (ctx.totalItems === 0) return ''

    const sections: string[] = ['## Memory Context', '']

    if (ctx.lessons) {
      sections.push('### Lessons from Past Runs')
      sections.push(ctx.lessons)
      sections.push('')
    }

    if (ctx.conventions) {
      sections.push('### Project Conventions')
      sections.push(ctx.conventions)
      sections.push('')
    }

    if (ctx.warnings) {
      sections.push('### Known Pitfalls')
      sections.push(ctx.warnings)
      sections.push('')
    }

    return sections.join('\n').trimEnd()
  }

  /**
   * Convenience: prepare + format in one call.
   */
  async getPromptSection(params: {
    nodeId?: string
    taskType?: string
    errorType?: string
  }): Promise<string> {
    const ctx = await this.prepareContext(params)
    return this.formatAsPromptSection(ctx)
  }

  // ---------------------------------------------------------------------------
  // Private — Formatting
  // ---------------------------------------------------------------------------

  private formatLessons(items: StoreItem[]): string {
    if (items.length === 0) return ''

    return items.map(item => {
      const v = item.value
      const confidence = typeof v['confidence'] === 'number' ? v['confidence'] : 0.5
      const pct = Math.round(confidence * 100)
      const summary = typeof v['summary'] === 'string'
        ? v['summary']
        : typeof v['text'] === 'string'
          ? v['text']
          : String(v['id'] ?? 'Unknown lesson')

      return `- [${pct}%] ${summary}`
    }).join('\n')
  }

  private formatConventions(items: StoreItem[]): string {
    if (items.length === 0) return ''

    return items.map(item => {
      const v = item.value
      const name = typeof v['name'] === 'string' ? v['name'] : ''
      const description = typeof v['description'] === 'string' ? v['description'] : ''

      if (name && description) {
        return `- ${name}: ${description}`
      }
      if (name) {
        return `- ${name}`
      }
      if (description) {
        return `- ${description}`
      }

      const text = typeof v['text'] === 'string' ? v['text'] : String(v['id'] ?? '')
      return `- ${text}`
    }).join('\n')
  }

  private formatWarnings(items: StoreItem[]): string {
    if (items.length === 0) return ''

    return items.map(item => {
      const v = item.value
      const summary = typeof v['summary'] === 'string'
        ? v['summary']
        : typeof v['errorMessage'] === 'string'
          ? v['errorMessage']
          : typeof v['text'] === 'string'
            ? v['text']
            : String(v['id'] ?? 'Unknown error')

      const nodeId = typeof v['nodeId'] === 'string' ? v['nodeId'] : undefined
      const prefix = nodeId ? `${nodeId}: ` : ''

      return `- ${prefix}${summary}`
    }).join('\n')
  }
}
