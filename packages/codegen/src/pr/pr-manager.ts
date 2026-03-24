/**
 * PR lifecycle manager — state machine for autonomous pull request management.
 *
 * Pure functions: no side effects, no external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PRState =
  | 'coding'
  | 'pr_open'
  | 'ci_running'
  | 'review_pending'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'closed'

export interface ReviewComment {
  author: string
  body: string
  path?: string
  line?: number
  createdAt: string
}

export interface PRContext {
  owner: string
  repo: string
  branch: string
  baseBranch: string
  title: string
  body: string
  state: PRState
  prNumber?: number
  ciStatus?: 'pending' | 'success' | 'failure'
  reviewComments?: ReviewComment[]
}

export interface PRManagerConfig {
  /** Auto-merge when approved and CI passes (default: false) */
  autoMerge?: boolean
  /** Max review-fix cycles before giving up (default: 3) */
  maxReviewCycles?: number
}

export type PRAction =
  | { type: 'create_pr'; title: string; body: string }
  | { type: 'wait_ci' }
  | { type: 'wait_review' }
  | { type: 'address_feedback'; comments: ReviewComment[] }
  | { type: 'request_review' }
  | { type: 'merge' }
  | { type: 'close'; reason: string }
  | { type: 'done' }

export type PREvent =
  | { type: 'pr_created' }
  | { type: 'ci_started' }
  | { type: 'ci_passed' }
  | { type: 'ci_failed' }
  | { type: 'review_requested' }
  | { type: 'changes_requested' }
  | { type: 'approved' }
  | { type: 'merged' }
  | { type: 'closed' }

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const TRANSITION_MAP: Record<PRState, Partial<Record<PREvent['type'], PRState>>> = {
  coding: { pr_created: 'pr_open' },
  pr_open: { ci_started: 'ci_running', review_requested: 'review_pending', closed: 'closed' },
  ci_running: { ci_passed: 'review_pending', ci_failed: 'changes_requested', closed: 'closed' },
  review_pending: { changes_requested: 'changes_requested', approved: 'approved', closed: 'closed' },
  changes_requested: { pr_created: 'pr_open', ci_started: 'ci_running', closed: 'closed' },
  approved: { merged: 'merged', ci_started: 'ci_running', closed: 'closed' },
  merged: {},
  closed: {},
}

/**
 * Transition PR state based on an event.
 * Returns the current state unchanged if the transition is not valid.
 */
export function transitionState(current: PRState, event: PREvent): PRState {
  const next = TRANSITION_MAP[current][event.type]
  return next ?? current
}

// ---------------------------------------------------------------------------
// Next-action resolver
// ---------------------------------------------------------------------------

/**
 * Determine the next action the agent should take based on current PR state.
 */
export function getNextAction(ctx: PRContext, config?: PRManagerConfig): PRAction {
  const maxCycles = config?.maxReviewCycles ?? 3
  const autoMerge = config?.autoMerge ?? false

  switch (ctx.state) {
    case 'coding':
      return { type: 'create_pr', title: ctx.title, body: ctx.body }

    case 'pr_open':
      return { type: 'wait_ci' }

    case 'ci_running':
      return { type: 'wait_ci' }

    case 'review_pending':
      return { type: 'wait_review' }

    case 'changes_requested': {
      const feedbackRounds = (ctx.reviewComments ?? []).length
      if (feedbackRounds >= maxCycles) {
        return { type: 'close', reason: `Exceeded max review cycles (${maxCycles})` }
      }
      return { type: 'address_feedback', comments: ctx.reviewComments ?? [] }
    }

    case 'approved':
      if (ctx.ciStatus === 'failure') {
        return { type: 'address_feedback', comments: [] }
      }
      if (ctx.ciStatus === 'pending') {
        return { type: 'wait_ci' }
      }
      return autoMerge ? { type: 'merge' } : { type: 'request_review' }

    case 'merged':
      return { type: 'done' }

    case 'closed':
      return { type: 'done' }
  }
}

// ---------------------------------------------------------------------------
// PR description builder
// ---------------------------------------------------------------------------

/**
 * Build a PR description from a summary, list of changes, and optional test plan.
 */
export function buildPRDescription(
  summary: string,
  changes: Array<{ file: string; description: string }>,
  testPlan?: string,
): string {
  const lines: string[] = ['## Summary', '', summary, '', '## Changes', '']

  for (const change of changes) {
    lines.push(`- \`${change.file}\` — ${change.description}`)
  }

  if (testPlan) {
    lines.push('', '## Test Plan', '', testPlan)
  }

  return lines.join('\n')
}
