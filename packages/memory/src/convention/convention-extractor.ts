/**
 * Convention Extractor — detects project coding conventions from code samples
 * and checks conformance of new code against stored conventions.
 *
 * Works with or without an LLM:
 * - With LLM: full analysis of conventions from code, intelligent conformance checking
 * - Without LLM: regex-based heuristic detection for common patterns
 *
 * Conventions are stored via MemoryService in a dedicated namespace.
 */
import type { MemoryService } from '../memory-service.js'
import type {
  ConventionExtractorConfig,
  ConventionFilter,
  ConsolidateOptions,
  DetectedConvention,
  ConventionCheckResult,
  ConventionCategory,
} from './types.js'

const DEFAULT_NAMESPACE = '__conventions'
const CONVENTION_SCOPE_KEY = 'conventions'

interface HeuristicRule {
  id: string
  name: string
  category: ConventionCategory
  description: string
  pattern: string
  test: (content: string) => boolean
}

const HEURISTIC_RULES: HeuristicRule[] = [
  {
    id: 'naming-camelcase-vars',
    name: 'camelCase variables',
    category: 'naming',
    description: 'Use camelCase for local variable declarations',
    pattern: '\\b(const|let|var)\\s+[a-z][a-zA-Z0-9]*\\b',
    test: (content) => {
      const matches = content.match(/\b(?:const|let|var)\s+[a-z][a-zA-Z0-9]*\b/g)
      return (matches?.length ?? 0) >= 2
    },
  },
  {
    id: 'naming-pascalcase-classes',
    name: 'PascalCase classes',
    category: 'naming',
    description: 'Use PascalCase for class and interface names',
    pattern: '\\b(class|interface|type)\\s+[A-Z][a-zA-Z0-9]*\\b',
    test: (content) => {
      const matches = content.match(/\b(?:class|interface|type)\s+[A-Z][a-zA-Z0-9]*\b/g)
      return (matches?.length ?? 0) >= 1
    },
  },
  {
    id: 'imports-named',
    name: 'Named imports over default',
    category: 'imports',
    description: 'Prefer named imports over default imports',
    pattern: "import\\s+\\{[^}]+\\}\\s+from",
    test: (content) => {
      const named = content.match(/import\s+\{[^}]+\}\s+from/g)?.length ?? 0
      const defaultImport = content.match(/import\s+[A-Z]\w+\s+from/g)?.length ?? 0
      return named > 0 && named >= defaultImport
    },
  },
  {
    id: 'imports-esm-extension',
    name: 'ESM .js extension in imports',
    category: 'imports',
    description: 'Include .js extension in relative import paths',
    pattern: "from\\s+['\"]\\./.*\\.js['\"]",
    test: (content) => {
      const withExt = content.match(/from\s+['"]\.\/.*\.js['"]/g)?.length ?? 0
      return withExt >= 1
    },
  },
  {
    id: 'typing-no-any',
    name: 'No explicit any',
    category: 'typing',
    description: 'Avoid explicit use of `any` type annotations',
    pattern: ':\\s*any\\b',
    test: (content) => {
      const anyUsages = content.match(/:\s*any\b/g)?.length ?? 0
      return anyUsages === 0 && content.length > 50
    },
  },
  {
    id: 'error-handling-try-catch',
    name: 'Try-catch for async operations',
    category: 'error-handling',
    description: 'Wrap async operations in try-catch blocks',
    pattern: 'try\\s*\\{[\\s\\S]*?await[\\s\\S]*?\\}\\s*catch',
    test: (content) => {
      const tryCatchAsync = content.match(/try\s*\{[\s\S]*?await[\s\S]*?\}\s*catch/g)
      return (tryCatchAsync?.length ?? 0) >= 1
    },
  },
  {
    id: 'typing-explicit-return',
    name: 'Explicit return types',
    category: 'typing',
    description: 'Functions have explicit return type annotations',
    pattern: '\\)\\s*:\\s*\\w+',
    test: (content) => {
      const withReturn = content.match(/\)\s*:\s*(?:Promise<|void|string|number|boolean|\w+(?:\[\])?)\s*[{]/g)
      return (withReturn?.length ?? 0) >= 2
    },
  },
  {
    id: 'structure-export-const',
    name: 'Export const for functions',
    category: 'structure',
    description: 'Use export const for stateless functions',
    pattern: 'export\\s+const\\s+\\w+\\s*=',
    test: (content) => {
      const matches = content.match(/export\s+const\s+\w+\s*=/g)
      return (matches?.length ?? 0) >= 1
    },
  },
]

export class ConventionExtractor {
  private readonly memoryService: MemoryService
  private readonly llm: ((prompt: string) => Promise<string>) | undefined
  private readonly namespace: string

  constructor(config: ConventionExtractorConfig) {
    this.memoryService = config.memoryService
    this.llm = config.llm
    this.namespace = config.namespace ?? DEFAULT_NAMESPACE
  }

  // ---------------------------------------------------------------------------
  // Analyze
  // ---------------------------------------------------------------------------

  /**
   * Analyze code files to detect conventions.
   * Returns newly detected or updated conventions.
   */
  async analyzeCode(
    files: Array<{ path: string; content: string }>,
  ): Promise<DetectedConvention[]> {
    const allContent = files.map(f => f.content).join('\n')
    const detected = this.llm
      ? await this.analyzeWithLLM(files)
      : this.analyzeWithHeuristics(allContent)

    const results: DetectedConvention[] = []

    for (const conv of detected) {
      const existing = await this.findExisting(conv.id)
      if (existing) {
        // Merge: increment occurrences, keep higher confidence, combine examples
        const merged: DetectedConvention = {
          ...existing,
          occurrences: existing.occurrences + conv.occurrences,
          confidence: Math.max(existing.confidence, conv.confidence),
          examples: deduplicateStrings([...existing.examples, ...conv.examples]).slice(0, 5),
        }
        await this.storeConvention(merged)
        results.push(merged)
      } else {
        await this.storeConvention(conv)
        results.push(conv)
      }
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Get all stored conventions, optionally filtered.
   */
  async getConventions(filter?: ConventionFilter): Promise<DetectedConvention[]> {
    const records = await this.memoryService.get(
      this.namespace,
      { scope: CONVENTION_SCOPE_KEY },
    )

    let conventions = records.map(r => recordToConvention(r))

    if (filter?.category) {
      conventions = conventions.filter(c => c.category === filter.category)
    }
    if (filter?.techStack) {
      conventions = conventions.filter(c => c.techStack === filter.techStack)
    }
    if (filter?.minConfidence !== undefined) {
      const min = filter.minConfidence
      conventions = conventions.filter(c => c.confidence >= min)
    }

    return conventions
  }

  // ---------------------------------------------------------------------------
  // Conformance
  // ---------------------------------------------------------------------------

  /**
   * Check code conformance against stored conventions.
   */
  async checkConformance(
    code: string,
    conventions?: DetectedConvention[],
  ): Promise<ConventionCheckResult> {
    const activeConventions = conventions ?? await this.getActiveConventions()

    if (activeConventions.length === 0) {
      return { conformanceScore: 1.0, followed: [], violated: [] }
    }

    if (this.llm) {
      return this.checkWithLLM(code, activeConventions)
    }
    return this.checkWithHeuristics(code, activeConventions)
  }

  // ---------------------------------------------------------------------------
  // Human Verdicts
  // ---------------------------------------------------------------------------

  /**
   * Set human verdict on a convention.
   * Confirmed: confidence set to 1.0, humanVerified = true
   * Rejected: confidence set to 0, humanVerified = false
   */
  async setHumanVerdict(conventionId: string, confirmed: boolean): Promise<void> {
    const existing = await this.findExisting(conventionId)
    if (!existing) return

    const updated: DetectedConvention = {
      ...existing,
      confidence: confirmed ? 1.0 : 0,
      humanVerified: confirmed,
    }
    await this.storeConvention(updated)
  }

  // ---------------------------------------------------------------------------
  // Prompt Formatting
  // ---------------------------------------------------------------------------

  /**
   * Format conventions as markdown for system prompts.
   */
  async formatForPrompt(filter?: ConventionFilter): Promise<string> {
    const effectiveFilter: ConventionFilter = {
      ...filter,
      minConfidence: filter?.minConfidence ?? 0.5,
    }
    const conventions = await this.getConventions(effectiveFilter)

    if (conventions.length === 0) return ''

    // Group by category
    const grouped = new Map<string, DetectedConvention[]>()
    for (const c of conventions) {
      const arr = grouped.get(c.category) ?? []
      arr.push(c)
      grouped.set(c.category, arr)
    }

    const lines: string[] = ['## Project Conventions', '']
    for (const [category, items] of grouped) {
      lines.push(`### ${capitalize(category)}`)
      for (const item of items) {
        lines.push(
          `- **${item.name}**: ${item.description} (confidence: ${item.confidence.toFixed(2)})`,
        )
        if (item.examples.length > 0) {
          lines.push(`  Example: \`${item.examples[0]}\``)
        }
      }
      lines.push('')
    }

    return lines.join('\n').trim()
  }

  // ---------------------------------------------------------------------------
  // Consolidation
  // ---------------------------------------------------------------------------

  /**
   * Consolidate: merge similar conventions, prune low-confidence ones.
   */
  async consolidate(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }> {
    const minConfidence = options?.minConfidence ?? 0.3
    const mergeSimilarity = options?.mergeSimilarity ?? 0.8

    const all = await this.getConventions()
    let merged = 0
    let pruned = 0

    // Phase 1: Merge similar conventions within same category
    const byCategory = new Map<string, DetectedConvention[]>()
    for (const c of all) {
      const arr = byCategory.get(c.category) ?? []
      arr.push(c)
      byCategory.set(c.category, arr)
    }

    const surviving = new Map<string, DetectedConvention>()
    for (const [_category, items] of byCategory) {
      const mergedItems = this.mergeSimilarConventions(items, mergeSimilarity)
      merged += items.length - mergedItems.length
      for (const item of mergedItems) {
        surviving.set(item.id, item)
      }
    }

    // Phase 2: Prune low-confidence non-verified conventions
    const toPrune: string[] = []
    for (const [id, conv] of surviving) {
      if (conv.confidence < minConfidence && conv.humanVerified !== true) {
        toPrune.push(id)
        pruned++
      }
    }
    for (const id of toPrune) {
      surviving.delete(id)
    }

    // Rewrite all conventions
    // Delete old conventions by overwriting the scope with fresh data
    // (MemoryService doesn't have a delete, so we overwrite each key)
    for (const conv of all) {
      if (!surviving.has(conv.id)) {
        // Write a tombstone (empty value) — effectively "deletes" from get results
        // We mark it with _deleted so getConventions filters it out
        await this.memoryService.put(
          this.namespace,
          { scope: CONVENTION_SCOPE_KEY },
          conv.id,
          { _deleted: true },
        )
      }
    }

    // Write surviving (possibly merged) conventions
    for (const conv of surviving.values()) {
      await this.storeConvention(conv)
    }

    return { merged, pruned }
  }

  // ---------------------------------------------------------------------------
  // Private — Analysis
  // ---------------------------------------------------------------------------

  private analyzeWithHeuristics(content: string): DetectedConvention[] {
    const detected: DetectedConvention[] = []
    for (const rule of HEURISTIC_RULES) {
      if (rule.test(content)) {
        // Extract a short example from the content
        const regex = new RegExp(rule.pattern)
        const match = regex.exec(content)
        const example = match ? match[0] : ''

        detected.push({
          id: rule.id,
          name: rule.name,
          category: rule.category,
          description: rule.description,
          pattern: rule.pattern,
          examples: example ? [example] : [],
          confidence: 0.6,
          occurrences: 1,
        })
      }
    }
    return detected
  }

  private async analyzeWithLLM(
    files: Array<{ path: string; content: string }>,
  ): Promise<DetectedConvention[]> {
    const fileSummaries = files
      .map(f => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`)
      .join('\n\n')

    const prompt = `Analyze the following code files and identify coding conventions used in this project.

For each convention, return a JSON array of objects with these fields:
- id: a kebab-case identifier (e.g., "naming-camelcase-vars")
- name: short human-readable name
- category: one of "naming", "structure", "imports", "error-handling", "typing", "testing", "api", "database", "styling", "general"
- description: one-sentence description
- pattern: optional regex pattern that identifies this convention
- examples: array of 1-3 short code snippets demonstrating it
- confidence: number 0.0-1.0 (how certain you are this is an intentional convention)
- occurrences: estimated count in the provided files

Return ONLY valid JSON array, no markdown fences, no explanation.

Files:
${fileSummaries}`

    try {
      const response = await this.llm!(prompt)
      const parsed = parseLLMJsonArray(response)
      return parsed.map(item => ({
        id: String(item['id'] ?? `convention-${Date.now()}`),
        name: String(item['name'] ?? 'Unknown convention'),
        category: validateCategory(String(item['category'] ?? 'general')),
        description: String(item['description'] ?? ''),
        pattern: item['pattern'] != null ? String(item['pattern']) : undefined,
        examples: Array.isArray(item['examples'])
          ? (item['examples'] as unknown[]).map(e => String(e))
          : [],
        confidence: clamp(Number(item['confidence'] ?? 0.7), 0, 1),
        occurrences: Math.max(1, Math.floor(Number(item['occurrences'] ?? 1))),
      }))
    } catch {
      // Fall back to heuristics on LLM failure
      const allContent = files.map(f => f.content).join('\n')
      return this.analyzeWithHeuristics(allContent)
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Conformance
  // ---------------------------------------------------------------------------

  private checkWithHeuristics(
    code: string,
    conventions: DetectedConvention[],
  ): ConventionCheckResult {
    const followed: ConventionCheckResult['followed'] = []
    const violated: ConventionCheckResult['violated'] = []

    for (const conv of conventions) {
      if (!conv.pattern) continue

      try {
        const regex = new RegExp(conv.pattern)
        if (regex.test(code)) {
          followed.push({ convention: conv, evidence: `Pattern "${conv.pattern}" matched` })
        } else {
          violated.push({
            convention: conv,
            evidence: `Pattern "${conv.pattern}" not found in code`,
            suggestion: `Consider following convention: ${conv.description}`,
          })
        }
      } catch {
        // Invalid regex — skip this convention
      }
    }

    const total = followed.length + violated.length
    const conformanceScore = total === 0 ? 1.0 : followed.length / total

    return { conformanceScore, followed, violated }
  }

  private async checkWithLLM(
    code: string,
    conventions: DetectedConvention[],
  ): Promise<ConventionCheckResult> {
    const conventionList = conventions
      .map(c => `- ${c.name} (${c.category}): ${c.description}`)
      .join('\n')

    const prompt = `Check if the following code follows these project conventions:

Conventions:
${conventionList}

Code:
${code.slice(0, 5000)}

For each convention, determine if it is followed or violated.
Return a JSON object with:
- followed: array of { conventionId: string, evidence: string }
- violated: array of { conventionId: string, evidence: string, suggestion: string }

Return ONLY valid JSON, no markdown fences.`

    try {
      const response = await this.llm!(prompt)
      const parsed = parseLLMJsonObject(response)
      const conventionMap = new Map(conventions.map(c => [c.id, c]))

      const followedRaw = Array.isArray(parsed['followed']) ? parsed['followed'] as unknown[] : []
      const violatedRaw = Array.isArray(parsed['violated']) ? parsed['violated'] as unknown[] : []

      const followedResults: ConventionCheckResult['followed'] = []
      const violatedResults: ConventionCheckResult['violated'] = []

      for (const item of followedRaw) {
        const obj = item as Record<string, unknown>
        const conv = conventionMap.get(String(obj['conventionId'] ?? ''))
        if (conv) {
          followedResults.push({ convention: conv, evidence: String(obj['evidence'] ?? '') })
        }
      }

      for (const item of violatedRaw) {
        const obj = item as Record<string, unknown>
        const conv = conventionMap.get(String(obj['conventionId'] ?? ''))
        if (conv) {
          violatedResults.push({
            convention: conv,
            evidence: String(obj['evidence'] ?? ''),
            suggestion: String(obj['suggestion'] ?? ''),
          })
        }
      }

      const total = followedResults.length + violatedResults.length
      const conformanceScore = total === 0 ? 1.0 : followedResults.length / total

      return { conformanceScore, followed: followedResults, violated: violatedResults }
    } catch {
      // Fall back to heuristic check on LLM failure
      return this.checkWithHeuristics(code, conventions)
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Storage
  // ---------------------------------------------------------------------------

  private async storeConvention(conv: DetectedConvention): Promise<void> {
    await this.memoryService.put(
      this.namespace,
      { scope: CONVENTION_SCOPE_KEY },
      conv.id,
      conventionToRecord(conv),
    )
  }

  private async findExisting(id: string): Promise<DetectedConvention | null> {
    const records = await this.memoryService.get(
      this.namespace,
      { scope: CONVENTION_SCOPE_KEY },
      id,
    )
    if (records.length === 0) return null
    const record = records[0]!
    if (record['_deleted']) return null
    return recordToConvention(record)
  }

  private async getActiveConventions(): Promise<DetectedConvention[]> {
    const all = await this.getConventions()
    return all.filter(c => c.confidence > 0 && c.humanVerified !== false)
  }

  // ---------------------------------------------------------------------------
  // Private — Merging
  // ---------------------------------------------------------------------------

  private mergeSimilarConventions(
    items: DetectedConvention[],
    threshold: number,
  ): DetectedConvention[] {
    if (items.length <= 1) return items

    const result: DetectedConvention[] = []
    const consumed = new Set<number>()

    for (let i = 0; i < items.length; i++) {
      if (consumed.has(i)) continue
      let current = items[i]!
      for (let j = i + 1; j < items.length; j++) {
        if (consumed.has(j)) continue
        const other = items[j]!
        if (stringSimilarity(current.name, other.name) >= threshold) {
          // Merge: keep the one with higher confidence
          current = {
            ...(current.confidence >= other.confidence ? current : other),
            occurrences: current.occurrences + other.occurrences,
            confidence: Math.max(current.confidence, other.confidence),
            examples: deduplicateStrings([...current.examples, ...other.examples]).slice(0, 5),
            humanVerified: current.humanVerified ?? other.humanVerified,
          }
          consumed.add(j)
        }
      }
      result.push(current)
    }

    return result
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conventionToRecord(conv: DetectedConvention): Record<string, unknown> {
  return {
    id: conv.id,
    name: conv.name,
    category: conv.category,
    description: conv.description,
    pattern: conv.pattern,
    examples: conv.examples,
    confidence: conv.confidence,
    occurrences: conv.occurrences,
    techStack: conv.techStack,
    humanVerified: conv.humanVerified,
    text: `${conv.name}: ${conv.description}`,
  }
}

function recordToConvention(record: Record<string, unknown>): DetectedConvention {
  return {
    id: String(record['id'] ?? ''),
    name: String(record['name'] ?? ''),
    category: validateCategory(String(record['category'] ?? 'general')),
    description: String(record['description'] ?? ''),
    pattern: record['pattern'] != null ? String(record['pattern']) : undefined,
    examples: Array.isArray(record['examples'])
      ? (record['examples'] as unknown[]).map(e => String(e))
      : [],
    confidence: Number(record['confidence'] ?? 0),
    occurrences: Number(record['occurrences'] ?? 0),
    techStack: record['techStack'] != null ? String(record['techStack']) : undefined,
    humanVerified: record['humanVerified'] != null
      ? Boolean(record['humanVerified'])
      : undefined,
  }
}

const VALID_CATEGORIES = new Set<ConventionCategory>([
  'naming', 'structure', 'imports', 'error-handling', 'typing',
  'testing', 'api', 'database', 'styling', 'general',
])

function validateCategory(raw: string): ConventionCategory {
  return VALID_CATEGORIES.has(raw as ConventionCategory)
    ? (raw as ConventionCategory)
    : 'general'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function deduplicateStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

/**
 * Simple bigram-based string similarity (Dice coefficient).
 */
function stringSimilarity(a: string, b: string): number {
  const lower_a = a.toLowerCase()
  const lower_b = b.toLowerCase()
  if (lower_a === lower_b) return 1.0
  if (lower_a.length < 2 || lower_b.length < 2) return 0

  const bigramsA = new Set<string>()
  for (let i = 0; i < lower_a.length - 1; i++) {
    bigramsA.add(lower_a.slice(i, i + 2))
  }
  const bigramsB = new Set<string>()
  for (let i = 0; i < lower_b.length - 1; i++) {
    bigramsB.add(lower_b.slice(i, i + 2))
  }

  let intersection = 0
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size)
}

function parseLLMJsonArray(raw: string): Array<Record<string, unknown>> {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) return []
  return parsed as Array<Record<string, unknown>>
}

function parseLLMJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}
