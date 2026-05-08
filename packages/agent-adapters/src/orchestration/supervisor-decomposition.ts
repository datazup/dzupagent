/**
 * Supervisor decomposition strategies.
 *
 * Provides the default `KeywordTaskDecomposer` plus the keyword-rule table
 * used to classify sentences into execution / reasoning / general tasks.
 */

import type { SubTask, TaskDecomposer } from './supervisor-types.js'

/** Keyword-based patterns used for default decomposition. */
interface DecompositionRule {
  pattern: RegExp
  tags: string[]
  requiresExecution: boolean
  requiresReasoning: boolean
}

const DECOMPOSITION_RULES: DecompositionRule[] = [
  {
    pattern: /\b(?:review|analyze|evaluate|assess|audit)\b/i,
    tags: ['reasoning', 'analysis'],
    requiresExecution: false,
    requiresReasoning: true,
  },
  {
    pattern: /\b(?:implement|build|create|develop|write|add)\b/i,
    tags: ['execution', 'implementation'],
    requiresExecution: true,
    requiresReasoning: false,
  },
  {
    pattern: /\b(?:fix|repair|patch|debug|resolve)\b/i,
    tags: ['execution', 'bugfix'],
    requiresExecution: true,
    requiresReasoning: false,
  },
  {
    pattern: /\b(?:test|verify|validate|check)\b/i,
    tags: ['execution', 'testing'],
    requiresExecution: true,
    requiresReasoning: false,
  },
]

/**
 * Default decomposer that splits goals into subtasks using keyword heuristics.
 *
 * Splitting strategy:
 * 1. Split the goal on sentence boundaries (`.` / `;` / `\n`).
 * 2. Classify each sentence against keyword rules.
 * 3. If no split is possible, return the whole goal as a single subtask.
 */
export class KeywordTaskDecomposer implements TaskDecomposer {
  async decompose(goal: string, _context?: string): Promise<SubTask[]> {
    // Split on sentence / line boundaries and drop empties
    const sentences = goal
      .split(/[.;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    if (sentences.length <= 1) {
      return [this.classifySentence(goal)]
    }

    return sentences.map((sentence) => this.classifySentence(sentence))
  }

  private classifySentence(sentence: string): SubTask {
    for (const rule of DECOMPOSITION_RULES) {
      if (rule.pattern.test(sentence)) {
        return {
          description: sentence,
          tags: rule.tags,
          requiresExecution: rule.requiresExecution,
          requiresReasoning: rule.requiresReasoning,
        }
      }
    }

    // Fallback: treat as a general execution task
    return {
      description: sentence,
      tags: ['general'],
      requiresExecution: true,
      requiresReasoning: false,
    }
  }
}
