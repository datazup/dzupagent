/**
 * Assignment-validator helpers extracted from DelegatingSupervisor.
 *
 * Detects duplicate-specialist {@link TaskAssignment} batches that lack stable
 * `id`s, formats a human-readable warning message, and exposes a single
 * `guardDuplicateSpecialistAssignmentIds` entry point that either throws,
 * emits, or no-ops based on the configured mode.
 *
 * Depends only on `@dzupagent/core` (via `typedEmit` and `DzupEventBus`) and
 * sibling files inside this package.
 */

import { typedEmit, type DzupEventBus } from '@dzupagent/core'
import { OrchestrationError } from './orchestration-error.js'

/** Minimal shape required by the duplicate-specialist guard. */
export interface AssignmentLike {
  id?: string
  specialistId: string
}

/** Behavior when a parallel batch repeats a specialist without stable assignment IDs. */
export type DuplicateSpecialistAssignmentIdMode = 'allow' | 'warn' | 'strict'

/** Detail surfaced via warn/strict events for a single offending specialist. */
export interface DuplicateSpecialistAssignmentIdWarning {
  specialistId: string
  assignmentIndexes: number[]
  missingAssignmentIdIndexes: number[]
}

/**
 * Locate specialists that appear more than once in a parallel batch where at
 * least one of the duplicates is missing a stable `id`.
 *
 * Returns one warning entry per offending specialist. The list is empty when
 * the batch is safe.
 */
export function findDuplicateSpecialistAssignmentsWithoutIds(
  tasks: readonly AssignmentLike[],
): DuplicateSpecialistAssignmentIdWarning[] {
  const bySpecialist = new Map<string, number[]>()

  tasks.forEach((task, index) => {
    const indexes = bySpecialist.get(task.specialistId)
    if (indexes) {
      indexes.push(index)
    } else {
      bySpecialist.set(task.specialistId, [index])
    }
  })

  const warnings: DuplicateSpecialistAssignmentIdWarning[] = []
  for (const [specialistId, assignmentIndexes] of bySpecialist) {
    if (assignmentIndexes.length < 2) continue

    const missingAssignmentIdIndexes = assignmentIndexes.filter((index) => {
      const id = tasks[index]?.id
      return id === undefined || id.length === 0
    })

    if (missingAssignmentIdIndexes.length === 0) continue
    warnings.push({
      specialistId,
      assignmentIndexes,
      missingAssignmentIdIndexes,
    })
  }

  return warnings
}

/** Render a single human-readable message describing every offending warning. */
export function formatDuplicateSpecialistAssignmentIdMessage(
  warnings: readonly DuplicateSpecialistAssignmentIdWarning[],
): string {
  const details = warnings
    .map((warning) => {
      const allIndexes = warning.assignmentIndexes.join(', ')
      const missingIndexes = warning.missingAssignmentIdIndexes.join(', ')
      return `${warning.specialistId} at indexes ${allIndexes} (missing IDs at ${missingIndexes})`
    })
    .join('; ')

  return `delegateAndCollect received duplicate specialist assignments without stable assignment IDs: ${details}. Provide TaskAssignment.id for every assignment in duplicate-specialist batches.`
}

/**
 * Apply the configured mode to a batch:
 *   - `allow`  → no-op.
 *   - `warn`   → emit `supervisor:duplicate_specialist_assignment_ids` event.
 *   - `strict` → throw {@link OrchestrationError} before any work starts.
 */
export function guardDuplicateSpecialistAssignmentIds(
  tasks: readonly AssignmentLike[],
  mode: DuplicateSpecialistAssignmentIdMode,
  eventBus: DzupEventBus | undefined,
): void {
  if (mode === 'allow') return

  const warnings = findDuplicateSpecialistAssignmentsWithoutIds(tasks)
  if (warnings.length === 0) return

  const message = formatDuplicateSpecialistAssignmentIdMessage(warnings)
  if (mode === 'strict') {
    throw new OrchestrationError(message, 'delegation', {
      duplicateSpecialists: warnings,
    })
  }

  typedEmit(eventBus, {
    type: 'supervisor:duplicate_specialist_assignment_ids',
    mode: 'warn',
    duplicateSpecialists: warnings,
    message,
  })
}
