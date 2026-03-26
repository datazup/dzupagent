import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatGitContext, type GitContext } from '../git/git-middleware.js'
import {
  transitionState,
  getNextAction,
  buildPRDescription,
  type PRState,
  type PRContext,
  type PREvent,
} from '../pr/pr-manager.js'
import {
  classifyCommentSeverity,
  consolidateReviews,
  buildReviewFixPrompt,
  type ReviewFeedback,
} from '../pr/review-handler.js'

// ---------------------------------------------------------------------------
// formatGitContext (pure function, no git needed)
// ---------------------------------------------------------------------------

describe('formatGitContext', () => {
  it('should format clean working tree', () => {
    const ctx: GitContext = {
      branch: 'main',
      status: '(clean working tree)',
      recentCommits: '  abc1234 feat: initial commit',
      isDirty: false,
    }

    const output = formatGitContext(ctx)

    expect(output).toContain('## Git Context')
    expect(output).toContain('**Branch:** main')
    expect(output).toContain('(clean working tree)')
    expect(output).toContain('abc1234 feat: initial commit')
  })

  it('should format dirty working tree', () => {
    const ctx: GitContext = {
      branch: 'feature/add-auth',
      status: '  modified src/auth.ts\n  added src/token.ts',
      recentCommits: '  1234567 chore: setup\n  abcdef0 feat: base',
      isDirty: true,
    }

    const output = formatGitContext(ctx)

    expect(output).toContain('feature/add-auth')
    expect(output).toContain('modified src/auth.ts')
    expect(output).toContain('Recent commits')
  })
})

// ---------------------------------------------------------------------------
// PR Manager State Machine
// ---------------------------------------------------------------------------

describe('PR Manager State Machine', () => {
  describe('transitionState', () => {
    it('should transition from coding to pr_open', () => {
      expect(transitionState('coding', { type: 'pr_created' })).toBe('pr_open')
    })

    it('should transition from pr_open to ci_running', () => {
      expect(transitionState('pr_open', { type: 'ci_started' })).toBe('ci_running')
    })

    it('should transition from ci_running to review_pending on CI pass', () => {
      expect(transitionState('ci_running', { type: 'ci_passed' })).toBe('review_pending')
    })

    it('should transition from ci_running to changes_requested on CI fail', () => {
      expect(transitionState('ci_running', { type: 'ci_failed' })).toBe('changes_requested')
    })

    it('should transition from review_pending to approved', () => {
      expect(transitionState('review_pending', { type: 'approved' })).toBe('approved')
    })

    it('should transition from review_pending to changes_requested', () => {
      expect(transitionState('review_pending', { type: 'changes_requested' })).toBe('changes_requested')
    })

    it('should transition from approved to merged', () => {
      expect(transitionState('approved', { type: 'merged' })).toBe('merged')
    })

    it('should return current state for invalid transitions', () => {
      expect(transitionState('merged', { type: 'ci_started' })).toBe('merged')
      expect(transitionState('closed', { type: 'approved' })).toBe('closed')
    })

    it('should allow closing from most states', () => {
      const closableStates: PRState[] = ['pr_open', 'ci_running', 'review_pending', 'changes_requested', 'approved']
      for (const state of closableStates) {
        expect(transitionState(state, { type: 'closed' })).toBe('closed')
      }
    })

    it('should allow re-entering CI from changes_requested', () => {
      expect(transitionState('changes_requested', { type: 'ci_started' })).toBe('ci_running')
    })

    it('should allow re-entering CI from approved', () => {
      expect(transitionState('approved', { type: 'ci_started' })).toBe('ci_running')
    })
  })

  describe('getNextAction', () => {
    function makeCtx(overrides: Partial<PRContext>): PRContext {
      return {
        owner: 'org',
        repo: 'repo',
        branch: 'feat/xyz',
        baseBranch: 'main',
        title: 'Add feature',
        body: 'Description',
        state: 'coding',
        ...overrides,
      }
    }

    it('should return create_pr when coding', () => {
      const action = getNextAction(makeCtx({ state: 'coding' }))
      expect(action.type).toBe('create_pr')
    })

    it('should return wait_ci when pr_open', () => {
      const action = getNextAction(makeCtx({ state: 'pr_open' }))
      expect(action.type).toBe('wait_ci')
    })

    it('should return wait_ci when ci_running', () => {
      const action = getNextAction(makeCtx({ state: 'ci_running' }))
      expect(action.type).toBe('wait_ci')
    })

    it('should return wait_review when review_pending', () => {
      const action = getNextAction(makeCtx({ state: 'review_pending' }))
      expect(action.type).toBe('wait_review')
    })

    it('should return address_feedback when changes_requested', () => {
      const comments = [{ author: 'reviewer', body: 'Fix this', createdAt: '2026-01-01' }]
      const action = getNextAction(makeCtx({ state: 'changes_requested', reviewComments: comments }))
      expect(action.type).toBe('address_feedback')
      if (action.type === 'address_feedback') {
        expect(action.comments).toEqual(comments)
      }
    })

    it('should close when max review cycles exceeded', () => {
      const comments = Array.from({ length: 5 }, (_, i) => ({
        author: 'reviewer',
        body: `Comment ${i}`,
        createdAt: '2026-01-01',
      }))
      const action = getNextAction(
        makeCtx({ state: 'changes_requested', reviewComments: comments }),
        { maxReviewCycles: 3 },
      )
      expect(action.type).toBe('close')
    })

    it('should merge when approved and autoMerge is true', () => {
      const action = getNextAction(
        makeCtx({ state: 'approved', ciStatus: 'success' }),
        { autoMerge: true },
      )
      expect(action.type).toBe('merge')
    })

    it('should request_review when approved and autoMerge is false', () => {
      const action = getNextAction(
        makeCtx({ state: 'approved', ciStatus: 'success' }),
        { autoMerge: false },
      )
      expect(action.type).toBe('request_review')
    })

    it('should wait_ci when approved but CI pending', () => {
      const action = getNextAction(makeCtx({ state: 'approved', ciStatus: 'pending' }))
      expect(action.type).toBe('wait_ci')
    })

    it('should address_feedback when approved but CI failed', () => {
      const action = getNextAction(makeCtx({ state: 'approved', ciStatus: 'failure' }))
      expect(action.type).toBe('address_feedback')
    })

    it('should return done when merged', () => {
      const action = getNextAction(makeCtx({ state: 'merged' }))
      expect(action.type).toBe('done')
    })

    it('should return done when closed', () => {
      const action = getNextAction(makeCtx({ state: 'closed' }))
      expect(action.type).toBe('done')
    })
  })

  describe('buildPRDescription', () => {
    it('should build description with summary and changes', () => {
      const desc = buildPRDescription(
        'Add user authentication',
        [
          { file: 'src/auth.ts', description: 'OAuth2 provider' },
          { file: 'src/middleware.ts', description: 'Auth middleware' },
        ],
      )

      expect(desc).toContain('## Summary')
      expect(desc).toContain('Add user authentication')
      expect(desc).toContain('## Changes')
      expect(desc).toContain('`src/auth.ts`')
      expect(desc).toContain('OAuth2 provider')
    })

    it('should include test plan when provided', () => {
      const desc = buildPRDescription(
        'Summary',
        [{ file: 'a.ts', description: 'change' }],
        '- [ ] Run unit tests\n- [ ] Manual QA',
      )

      expect(desc).toContain('## Test Plan')
      expect(desc).toContain('Run unit tests')
    })

    it('should omit test plan section when not provided', () => {
      const desc = buildPRDescription('Summary', [])
      expect(desc).not.toContain('## Test Plan')
    })
  })
})

// ---------------------------------------------------------------------------
// Review Handler
// ---------------------------------------------------------------------------

describe('Review Handler', () => {
  describe('classifyCommentSeverity', () => {
    it('should classify critical keywords', () => {
      expect(classifyCommentSeverity('This must be fixed')).toBe('critical')
      expect(classifyCommentSeverity('Security vulnerability here')).toBe('critical')
      expect(classifyCommentSeverity('This will crash the app')).toBe('critical')
      expect(classifyCommentSeverity('Breaking change detected')).toBe('critical')
    })

    it('should classify major keywords', () => {
      expect(classifyCommentSeverity('This should be refactored')).toBe('major')
      expect(classifyCommentSeverity('Important: missing validation')).toBe('major')
      expect(classifyCommentSeverity('This is incorrect logic')).toBe('major')
      expect(classifyCommentSeverity('This is a bug')).toBe('major')
    })

    it('should classify suggestion keywords', () => {
      expect(classifyCommentSeverity('Nit: spacing is off')).toBe('suggestion')
      expect(classifyCommentSeverity('Style issue here')).toBe('suggestion')
      expect(classifyCommentSeverity('Just a suggestion')).toBe('suggestion')
      expect(classifyCommentSeverity('This is optional')).toBe('suggestion')
    })

    it('should classify minor keywords', () => {
      expect(classifyCommentSeverity('You could rename this')).toBe('minor')
      expect(classifyCommentSeverity('Consider using a constant')).toBe('minor')
      expect(classifyCommentSeverity('Minor issue here')).toBe('minor')
    })

    it('should default to minor for unrecognized text', () => {
      expect(classifyCommentSeverity('Lorem ipsum dolor sit amet')).toBe('minor')
    })
  })

  describe('consolidateReviews', () => {
    it('should return empty summary for no comments', () => {
      const result = consolidateReviews([])
      expect(result.summary).toBe('No review comments.')
      expect(result.issues).toHaveLength(0)
      expect(result.affectedFiles).toHaveLength(0)
    })

    it('should consolidate multiple comments', () => {
      const comments = [
        { author: 'alice', body: 'This must be fixed', path: 'src/auth.ts', line: 10, createdAt: '2026-01-01' },
        { author: 'bob', body: 'Nit: spacing', path: 'src/auth.ts', line: 20, createdAt: '2026-01-01' },
        { author: 'alice', body: 'Could rename this', path: 'src/utils.ts', line: 5, createdAt: '2026-01-01' },
      ]

      const result = consolidateReviews(comments)

      expect(result.issues).toHaveLength(3)
      expect(result.affectedFiles).toEqual(['src/auth.ts', 'src/utils.ts'])
      expect(result.summary).toContain('3 review comments')
      expect(result.summary).toContain('critical')
      expect(result.summary).toContain('suggestion')
    })

    it('should handle comments without file paths', () => {
      const comments = [
        { author: 'alice', body: 'General feedback', createdAt: '2026-01-01' },
      ]

      const result = consolidateReviews(comments)
      expect(result.affectedFiles).toEqual([])
      expect(result.issues).toHaveLength(1)
    })

    it('should deduplicate affected files', () => {
      const comments = [
        { author: 'a', body: 'Fix this', path: 'src/a.ts', createdAt: '2026-01-01' },
        { author: 'b', body: 'Also fix this', path: 'src/a.ts', createdAt: '2026-01-01' },
      ]

      const result = consolidateReviews(comments)
      expect(result.affectedFiles).toEqual(['src/a.ts'])
    })
  })

  describe('buildReviewFixPrompt', () => {
    it('should build a formatted prompt from feedback', () => {
      const feedback: ReviewFeedback = {
        summary: '2 issues found.',
        affectedFiles: ['src/auth.ts'],
        issues: [
          { severity: 'critical', description: 'Missing validation', file: 'src/auth.ts', line: 10 },
          { severity: 'suggestion', description: 'Rename variable', file: 'src/auth.ts', line: 25 },
        ],
      }

      const prompt = buildReviewFixPrompt(feedback, 1)

      expect(prompt).toContain('attempt 1')
      expect(prompt).toContain('2 issues found.')
      expect(prompt).toContain('### Affected Files')
      expect(prompt).toContain('`src/auth.ts`')
      expect(prompt).toContain('### Critical Issues')
      expect(prompt).toContain('Missing validation')
      expect(prompt).toContain('### Suggestion Issues')
      expect(prompt).toContain('Rename variable')
      expect(prompt).toContain('Address all critical and major issues')
    })

    it('should omit severity sections with no issues', () => {
      const feedback: ReviewFeedback = {
        summary: '1 issue.',
        affectedFiles: ['a.ts'],
        issues: [
          { severity: 'minor', description: 'Minor thing', file: 'a.ts' },
        ],
      }

      const prompt = buildReviewFixPrompt(feedback, 2)

      expect(prompt).not.toContain('### Critical Issues')
      expect(prompt).not.toContain('### Major Issues')
      expect(prompt).toContain('### Minor Issues')
    })

    it('should include line numbers when available', () => {
      const feedback: ReviewFeedback = {
        summary: 'Issues.',
        affectedFiles: ['a.ts'],
        issues: [
          { severity: 'major', description: 'Bad logic', file: 'a.ts', line: 42 },
        ],
      }

      const prompt = buildReviewFixPrompt(feedback, 1)
      expect(prompt).toContain(':42')
    })

    it('should handle empty affected files', () => {
      const feedback: ReviewFeedback = {
        summary: 'General feedback.',
        affectedFiles: [],
        issues: [
          { severity: 'minor', description: 'General comment' },
        ],
      }

      const prompt = buildReviewFixPrompt(feedback, 1)
      expect(prompt).not.toContain('### Affected Files')
    })
  })
})
