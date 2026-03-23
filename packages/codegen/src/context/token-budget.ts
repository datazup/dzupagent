/**
 * Phase-aware context selection and token budget management.
 * Keeps prompt context within budget by summarising or omitting files.
 *
 * Extracted from apps/api token-budget.ts and made pluggable with
 * FileRoleDetector and PhasePriorityMatrix interfaces.
 */

// ---- Pluggable interfaces ---------------------------------------------------

export interface FileRoleDetector {
  detect(path: string): string
}

export interface PhasePriorityMatrix {
  getPriority(phase: string, role: string): 'full' | 'interface' | 'summary'
}

export interface FileEntry {
  path: string
  content: string
}

// ---- Default implementations ------------------------------------------------

type FileRole =
  | 'model'
  | 'type'
  | 'validator'
  | 'route'
  | 'controller'
  | 'service'
  | 'component'
  | 'store'
  | 'composable'
  | 'api-client'
  | 'test'
  | 'config'
  | 'other'

/** Built-in file role detection based on path patterns. */
export class DefaultRoleDetector implements FileRoleDetector {
  detect(path: string): string {
    const lower = path.toLowerCase()

    if (lower.endsWith('.prisma') || lower.includes('/schema')) return 'model'
    if (lower.includes('.test.') || lower.includes('.spec.') || lower.includes('__tests__')) return 'test'
    if (lower.includes('.types.') || lower.includes('/types/') || lower.includes('.dto.') || lower.includes('/dto/')) return 'type'
    if (lower.includes('.validator.') || lower.includes('.schema.') || lower.includes('/validators/') || lower.includes('/schemas/')) return 'validator'
    if (lower.includes('.routes.') || lower.includes('/routes/')) return 'route'
    if (lower.includes('.controller.') || lower.includes('/controllers/')) return 'controller'
    if (lower.includes('.service.') || lower.includes('/services/')) return 'service'
    if (lower.endsWith('.vue') || lower.includes('/components/')) return 'component'
    if (lower.includes('.store.') || lower.includes('/stores/')) return 'store'
    if (lower.includes('/composables/') || /\/use[A-Z]/.test(path)) return 'composable'
    if (lower.includes('.api.') || lower.includes('/api/')) return 'api-client'
    if (lower.includes('config') || lower.includes('manifest') || lower.includes('.env')) return 'config'
    return 'other'
  }
}

type Priority = 'full' | 'interface' | 'summary'

/** Built-in per-phase priority matrix. */
export class DefaultPriorityMatrix implements PhasePriorityMatrix {
  private static readonly PRIORITIES: Record<string, Partial<Record<FileRole, Priority>>> = {
    generate_db: {
      model: 'full',
      type: 'full',
      validator: 'interface',
      config: 'full',
    },
    generate_backend: {
      model: 'full',
      type: 'full',
      validator: 'full',
      route: 'full',
      controller: 'full',
      service: 'full',
      config: 'interface',
    },
    generate_frontend: {
      type: 'full',
      validator: 'full',
      route: 'full',
      controller: 'full',
      service: 'interface',
      component: 'full',
      store: 'full',
      composable: 'full',
      'api-client': 'full',
      model: 'interface',
    },
    generate_tests: {
      model: 'full',
      type: 'full',
      validator: 'full',
      route: 'full',
      controller: 'full',
      service: 'full',
      component: 'full',
      store: 'full',
      composable: 'full',
      'api-client': 'full',
      test: 'full',
    },
    fix: {
      model: 'full',
      type: 'full',
      validator: 'full',
      route: 'full',
      controller: 'full',
      service: 'full',
      component: 'full',
      store: 'full',
      composable: 'full',
      'api-client': 'full',
      test: 'full',
      config: 'full',
    },
  }

  getPriority(phase: string, role: string): Priority {
    const phaseMap = DefaultPriorityMatrix.PRIORITIES[phase]
    if (phaseMap) {
      return (phaseMap as Record<string, Priority | undefined>)[role] ?? 'summary'
    }
    // Default (review, validate, etc.): full for all
    return 'full'
  }
}

// ---- Summary functions ------------------------------------------------------

/** One-line summary: exports + line count. */
export function summarizeFile(path: string, content: string): string {
  const lines = content.split('\n').length
  const exports = [...content.matchAll(/^export (?:const|function|class|type|interface) (\w+)/gm)]
    .map((m) => m[1])
    .join(', ')
  const summary = exports ? `Exports: ${exports}. ` : ''
  return `${path}: ${summary}${lines} lines.`
}

/**
 * Interface summary: extract exported function signatures, type/interface
 * declarations, and import statements. More useful than a one-line summary
 * without full implementation bodies.
 */
export function extractInterfaceSummary(path: string, content: string): string {
  const lines = content.split('\n')
  const extracted: string[] = [`// --- ${path} (interface summary) ---`]

  let insideBlock = false
  let braceDepth = 0
  let currentBlock: string[] = []

  for (const line of lines) {
    const trimmed = line.trimStart()

    // Capture export type/interface blocks in full
    if (!insideBlock && /^export\s+(?:type|interface)\s+/.test(trimmed)) {
      insideBlock = true
      braceDepth = 0
      currentBlock = [line]
      for (const ch of line) {
        if (ch === '{') braceDepth++
        if (ch === '}') braceDepth--
      }
      if (braceDepth <= 0 && line.includes('{')) {
        extracted.push(currentBlock.join('\n'))
        insideBlock = false
        currentBlock = []
      }
      continue
    }

    if (insideBlock) {
      currentBlock.push(line)
      for (const ch of line) {
        if (ch === '{') braceDepth++
        if (ch === '}') braceDepth--
      }
      if (braceDepth <= 0) {
        extracted.push(currentBlock.join('\n'))
        insideBlock = false
        currentBlock = []
      }
      continue
    }

    // Capture export function signatures (just the signature line)
    if (/^export\s+(?:async\s+)?function\s+/.test(trimmed)) {
      const sigEnd = line.indexOf('{')
      extracted.push(sigEnd > 0 ? line.substring(0, sigEnd).trimEnd() : line)
      continue
    }

    // Capture export const arrow function signatures
    if (/^export\s+const\s+\w+\s*=/.test(trimmed)) {
      const sigEnd = line.indexOf('=>')
      if (sigEnd > 0) {
        extracted.push(line.substring(0, sigEnd + 2).trimEnd() + ' { ... }')
      } else {
        extracted.push(line)
      }
      continue
    }

    // Capture import statements
    if (trimmed.startsWith('import ')) {
      extracted.push(line)
    }
  }

  return extracted.length > 1 ? extracted.join('\n') : summarizeFile(path, content)
}

// ---- TokenBudgetManager -----------------------------------------------------

export interface TokenBudgetOptions {
  /** Total token budget for file context (default: 16000) */
  budgetTokens?: number
  /** Approximate characters per token (default: 4) */
  charsPerToken?: number
  /** Custom file role detector */
  roleDetector?: FileRoleDetector
  /** Custom phase-priority matrix */
  priorityMatrix?: PhasePriorityMatrix
}

/**
 * Manages token budgets for context selection.
 * Selects files for a generation phase, applying full/interface/summary
 * priorities to stay within the token budget.
 */
export class TokenBudgetManager {
  private readonly budgetTokens: number
  private readonly charsPerToken: number
  private readonly roleDetector: FileRoleDetector
  private readonly priorityMatrix: PhasePriorityMatrix

  constructor(options?: TokenBudgetOptions) {
    this.budgetTokens = options?.budgetTokens ?? 16_000
    this.charsPerToken = options?.charsPerToken ?? 4
    this.roleDetector = options?.roleDetector ?? new DefaultRoleDetector()
    this.priorityMatrix = options?.priorityMatrix ?? new DefaultPriorityMatrix()
  }

  /** Estimate token count for a string. */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / this.charsPerToken)
  }

  /** Summarize a file to a one-line description. */
  summarizeFile(path: string, content: string): string {
    return summarizeFile(path, content)
  }

  /** Extract interface-level summary of a file. */
  extractInterfaceSummary(path: string, content: string): string {
    return extractInterfaceSummary(path, content)
  }

  /**
   * Select files to include in context for a given generation phase.
   * Returns full content for high-priority files, interface summaries for
   * medium-priority, and one-line summaries for low-priority files.
   */
  selectFiles(vfs: Record<string, string>, phase: string): FileEntry[] {
    const allFiles = Object.entries(vfs).map(([path, content]) => {
      const role = this.roleDetector.detect(path)
      const priority = this.priorityMatrix.getPriority(phase, role)
      return { path, content, priority }
    })

    if (allFiles.length === 0) return []

    // Sort: full -> interface -> summary (process highest priority first)
    const priorityOrder: Record<string, number> = { full: 0, interface: 1, summary: 2 }
    allFiles.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2))

    let totalTokens = 0
    const result: FileEntry[] = []

    for (const file of allFiles) {
      if (file.priority === 'full') {
        const tokens = this.estimateTokens(file.content)
        if (totalTokens + tokens <= this.budgetTokens) {
          result.push({ path: file.path, content: file.content })
          totalTokens += tokens
        } else {
          // Over budget: downgrade to interface summary
          const ifSummary = extractInterfaceSummary(file.path, file.content)
          const ifTokens = this.estimateTokens(ifSummary)
          if (totalTokens + ifTokens <= this.budgetTokens) {
            result.push({ path: file.path, content: ifSummary })
            totalTokens += ifTokens
          } else {
            const summary = summarizeFile(file.path, file.content)
            result.push({ path: file.path, content: summary })
            totalTokens += this.estimateTokens(summary)
          }
        }
      } else if (file.priority === 'interface') {
        const ifSummary = extractInterfaceSummary(file.path, file.content)
        const tokens = this.estimateTokens(ifSummary)
        if (totalTokens + tokens <= this.budgetTokens) {
          result.push({ path: file.path, content: ifSummary })
          totalTokens += tokens
        } else {
          const summary = summarizeFile(file.path, file.content)
          result.push({ path: file.path, content: summary })
          totalTokens += this.estimateTokens(summary)
        }
      } else {
        // summary priority
        const summary = summarizeFile(file.path, file.content)
        result.push({ path: file.path, content: summary })
        totalTokens += this.estimateTokens(summary)
      }
    }

    return result
  }
}
