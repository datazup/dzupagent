/**
 * Phase-aware context windowing for LLM conversations.
 *
 * Instead of treating all messages equally during compression, this module
 * detects the current conversation phase (planning, coding, debugging, reviewing)
 * and scores each message for retention priority. Higher-scored messages are
 * preserved longer during compression, while low-value messages are summarized
 * sooner.
 */
import type { BaseMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Recognized conversation phases */
export type ConversationPhase =
  | 'planning'
  | 'coding'
  | 'debugging'
  | 'reviewing'
  | 'general'

/** Configuration for a conversation phase */
export interface PhaseConfig {
  name: ConversationPhase
  /** Regex patterns that indicate this phase is active */
  triggers: RegExp[]
  /** Message retention multiplier: 1.0 = normal, 2.0 = keep 2x longer, 0.5 = compress sooner */
  retentionMultiplier: number
  /** Message types to prioritize in this phase (preserve these longer) */
  priorityTypes: Array<'system' | 'human' | 'ai' | 'tool'>
}

/** Per-message retention score */
export interface MessageRetention {
  /** Index in the original message array */
  index: number
  /** Computed retention score (higher = keep longer) */
  score: number
  /** Why this score was assigned */
  reason: string
}

/** Phase detection result */
export interface PhaseDetection {
  /** Current detected phase */
  phase: ConversationPhase
  /** Confidence 0-1 */
  confidence: number
  /** Which trigger pattern matched */
  matchedPattern?: string
}

export interface PhaseWindowConfig {
  /** Phase configurations (uses defaults if not provided) */
  phases?: PhaseConfig[]
  /** Base retention score for each message type */
  baseScores?: Record<string, number>
  /** Number of recent messages to scan for phase detection (default: 5) */
  phaseDetectionWindow?: number
}

// ---------------------------------------------------------------------------
// Default phases
// ---------------------------------------------------------------------------

export const DEFAULT_PHASES: PhaseConfig[] = [
  {
    name: 'planning',
    triggers: [
      /\b(plan|design|architect|structure|approach|strategy)\b/i,
      /\b(requirements?|spec|proposal|rfc)\b/i,
      /\bhow should (we|I)\b/i,
    ],
    retentionMultiplier: 1.5,
    priorityTypes: ['human', 'ai'],
  },
  {
    name: 'coding',
    triggers: [
      /\b(implement|code|write|create|add|build|refactor)\b/i,
      /\b(function|class|component|module|file)\b/i,
      /```[\s\S]*```/,
    ],
    retentionMultiplier: 1.0,
    priorityTypes: ['ai', 'tool'],
  },
  {
    name: 'debugging',
    triggers: [
      /\b(error|bug|fix|debug|issue|fail|broken|crash)\b/i,
      /\b(stack\s*trace|exception|TypeError|undefined)\b/i,
      /\b(not working|doesn't work|won't compile)\b/i,
    ],
    retentionMultiplier: 2.0,
    priorityTypes: ['tool', 'ai', 'human'],
  },
  {
    name: 'reviewing',
    triggers: [
      /\b(review|check|verify|validate|test|approve)\b/i,
      /\b(looks good|lgtm|ship it|merge)\b/i,
    ],
    retentionMultiplier: 0.8,
    priorityTypes: ['human', 'ai'],
  },
]

const DEFAULT_BASE_SCORES: Record<string, number> = {
  system: 10,
  human: 5,
  ai: 4,
  tool: 3,
}

const DEFAULT_PHASE_DETECTION_WINDOW = 5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getContent(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

function getMessageType(m: BaseMessage): string {
  return m._getType()
}

function hasCodeBlocks(content: string): boolean {
  return /```[\s\S]*?```/.test(content)
}

function hasFilePaths(content: string): boolean {
  return /(?:\/[\w.-]+){2,}|[\w.-]+\.[tj]sx?|[\w.-]+\.vue/.test(content)
}

function hasErrorIndicators(content: string): boolean {
  return /\b(error|exception|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|stack\s*trace|failed|Fatal)\b/i.test(
    content,
  )
}

/**
 * Check if an AIMessage carries tool_calls (used for boundary alignment).
 */
function hasToolCalls(m: BaseMessage): boolean {
  if (m._getType() !== 'ai') return false
  const ai = m as { tool_calls?: Array<{ id?: string }> }
  return Array.isArray(ai.tool_calls) && ai.tool_calls.length > 0
}

// ---------------------------------------------------------------------------
// PhaseAwareWindowManager
// ---------------------------------------------------------------------------

export class PhaseAwareWindowManager {
  private readonly phases: PhaseConfig[]
  private readonly baseScores: Record<string, number>
  private readonly phaseDetectionWindow: number

  constructor(config?: PhaseWindowConfig) {
    this.phases = config?.phases ?? DEFAULT_PHASES
    this.baseScores = config?.baseScores ?? DEFAULT_BASE_SCORES
    this.phaseDetectionWindow = config?.phaseDetectionWindow ?? DEFAULT_PHASE_DETECTION_WINDOW
  }

  /**
   * Detect the current conversation phase from recent messages.
   * Scans the last N messages for trigger patterns.
   */
  detectPhase(messages: BaseMessage[]): PhaseDetection {
    const window = messages.slice(-this.phaseDetectionWindow)

    // Count matches per phase across the detection window
    const phaseCounts = new Map<ConversationPhase, { count: number; pattern: string }>()

    for (const msg of window) {
      const content = getContent(msg)
      for (const phase of this.phases) {
        for (const trigger of phase.triggers) {
          if (trigger.test(content)) {
            const existing = phaseCounts.get(phase.name)
            if (existing) {
              existing.count++
            } else {
              phaseCounts.set(phase.name, { count: 1, pattern: trigger.source })
            }
            break // one match per phase per message is enough
          }
        }
      }
    }

    if (phaseCounts.size === 0) {
      return { phase: 'general', confidence: 0.5 }
    }

    // Find the phase with the most matches
    let bestPhase: ConversationPhase = 'general'
    let bestCount = 0
    let bestPattern = ''

    for (const [phase, { count, pattern }] of phaseCounts) {
      if (count > bestCount) {
        bestPhase = phase
        bestCount = count
        bestPattern = pattern
      }
    }

    const confidence = Math.min(bestCount / window.length, 1.0)

    return {
      phase: bestPhase,
      confidence,
      matchedPattern: bestPattern,
    }
  }

  /**
   * Score each message for retention priority.
   * Higher scores = keep longer during compression.
   */
  scoreMessages(messages: BaseMessage[]): MessageRetention[] {
    const { phase } = this.detectPhase(messages)
    const phaseConfig = this.phases.find(p => p.name === phase)
    const multiplier = phaseConfig?.retentionMultiplier ?? 1.0
    const priorityTypes = phaseConfig?.priorityTypes ?? []
    const n = messages.length

    return messages.map((msg, i) => {
      const type = getMessageType(msg)
      const content = getContent(msg)
      const reasons: string[] = []

      // 1. Base score by message type
      const base = this.baseScores[type] ?? 3
      reasons.push(`base(${type})=${base}`)

      // 2. Recency bonus: 0 for oldest, 5 for newest
      const recency = n > 1 ? (i / (n - 1)) * 5 : 5
      reasons.push(`recency=${recency.toFixed(1)}`)

      // 3. Priority type bonus
      const priority = priorityTypes.includes(type as 'system' | 'human' | 'ai' | 'tool') ? 3 : 0
      if (priority > 0) reasons.push(`priority(${phase})=+${priority}`)

      // 4. Content value heuristics
      let contentBonus = 0
      if (hasCodeBlocks(content)) {
        contentBonus += 2
        reasons.push('code=+2')
      }
      if (hasFilePaths(content)) {
        contentBonus += 1
        reasons.push('paths=+1')
      }
      if (hasErrorIndicators(content)) {
        contentBonus += 2
        reasons.push('errors=+2')
      }
      if (content.length < 20) {
        contentBonus -= 2
        reasons.push('short=-2')
      }

      // 5. Phase multiplier applied to the sum
      const raw = base + recency + priority + contentBonus
      const score = raw * multiplier

      reasons.push(`x${multiplier}(${phase})`)

      return {
        index: i,
        score: Math.round(score * 100) / 100,
        reason: reasons.join(', '),
      }
    })
  }

  /**
   * Find a retention-aware split point for compression.
   *
   * Instead of a fixed split, walks backward from the end accumulating
   * messages into the "keep" section. Stops when targetKeep messages
   * are collected or when a low-scoring message boundary is found.
   * Adjusts for tool-call boundary alignment.
   *
   * @param messages The full message array
   * @param targetKeep Target number of messages to keep
   * @returns The index to split at (messages before this index get summarized)
   */
  findRetentionSplit(messages: BaseMessage[], targetKeep: number): number {
    if (messages.length <= targetKeep) return 0

    const scores = this.scoreMessages(messages)
    const allScoreValues = scores.map(s => s.score)
    allScoreValues.sort((a, b) => a - b)
    const median = allScoreValues[Math.floor(allScoreValues.length / 2)] ?? 0
    const threshold = median / 2

    // Walk backward from the end, accumulating "keep" messages
    let kept = 0
    let splitIdx = messages.length

    for (let i = messages.length - 1; i >= 0; i--) {
      const retention = scores[i]
      if (!retention) break

      if (kept >= targetKeep && retention.score < threshold) {
        // We have enough messages and hit a low-value one — stop here
        splitIdx = i + 1
        break
      }

      kept++
      splitIdx = i
    }

    // Ensure split doesn't exceed what we need
    splitIdx = Math.min(splitIdx, messages.length - targetKeep)
    splitIdx = Math.max(splitIdx, 0)

    // Boundary alignment: don't split in the middle of a tool-call group.
    // Walk backward past ToolMessages to keep them with their AIMessage.
    while (splitIdx > 0 && splitIdx < messages.length) {
      const msg = messages[splitIdx]
      if (msg && msg._getType() === 'tool') {
        splitIdx--
        continue
      }
      // If the previous message is an AI with tool_calls, include it too
      if (splitIdx > 0) {
        const prev = messages[splitIdx - 1]
        if (prev && hasToolCalls(prev)) {
          splitIdx--
          continue
        }
      }
      break
    }

    return Math.max(0, splitIdx)
  }
}
