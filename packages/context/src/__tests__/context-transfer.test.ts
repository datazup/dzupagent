import { describe, it, expect, beforeEach } from 'vitest'
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import {
  ContextTransferService,
  type ContextTransferConfig,
  type IntentRelevanceRule,
} from '../context-transfer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(...pairs: [string, string][]): BaseMessage[] {
  return pairs.flatMap(([human, ai]) => [
    new HumanMessage(human),
    new AIMessage(ai),
  ])
}

function messagesWithSystem(systemText: string, ...pairs: [string, string][]): BaseMessage[] {
  return [new SystemMessage(systemText), ...makeMessages(...pairs)]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextTransferService', () => {
  let service: ContextTransferService

  beforeEach(() => {
    service = new ContextTransferService()
  })

  // -----------------------------------------------------------------------
  // extractContext
  // -----------------------------------------------------------------------

  describe('extractContext', () => {
    it('builds a summary from recent human+ai messages', () => {
      const msgs = makeMessages(
        ['Build auth module', 'I will create an auth module with JWT.'],
        ['Use Argon2id for hashing', 'Decided to use Argon2id for password hashing.'],
      )
      const ctx = service.extractContext(msgs, 'implement')

      expect(ctx.fromIntent).toBe('implement')
      expect(ctx.toIntent).toBe('')
      expect(ctx.summary).toContain('[human]: Build auth module')
      expect(ctx.summary).toContain('[ai]: I will create an auth module')
      expect(ctx.transferredAt).toBeGreaterThan(0)
      expect(ctx.tokenEstimate).toBeGreaterThan(0)
    })

    it('extracts decisions from messages', () => {
      const msgs = makeMessages(
        ['What hashing to use?', 'Decided to use Argon2id for password hashing. Going with JWT for tokens.'],
      )
      const ctx = service.extractContext(msgs, 'implement')

      expect(ctx.decisions.length).toBeGreaterThanOrEqual(1)
      expect(ctx.decisions.some((d) => /Argon2id/.test(d))).toBe(true)
    })

    it('extracts file paths from messages', () => {
      const msgs = makeMessages(
        ['Check src/auth/service.ts', 'I modified src/auth/service.ts and src/auth/types.ts'],
      )
      const ctx = service.extractContext(msgs, 'edit')

      expect(ctx.relevantFiles).toContain('src/auth/service.ts')
      expect(ctx.relevantFiles).toContain('src/auth/types.ts')
    })

    it('deduplicates decisions', () => {
      const msgs = makeMessages(
        ['Plan', 'Decided to use Redis for caching.'],
        ['Confirm', 'Decided to use Redis for caching.'],
      )
      const ctx = service.extractContext(msgs, 'plan')

      const redisDecisions = ctx.decisions.filter((d) => /Redis/.test(d))
      expect(redisDecisions.length).toBe(1)
    })

    it('limits decisions to 10', () => {
      const msgs: BaseMessage[] = []
      for (let i = 0; i < 15; i++) {
        msgs.push(new AIMessage(`Decided to use tool-${i} for feature-${i}.`))
      }
      const ctx = service.extractContext(msgs, 'plan')
      expect(ctx.decisions.length).toBeLessThanOrEqual(10)
    })

    it('limits file paths to 20', () => {
      let content = ''
      for (let i = 0; i < 25; i++) {
        content += `src/module${i}/index.ts `
      }
      const msgs: BaseMessage[] = [new AIMessage(content)]
      const ctx = service.extractContext(msgs, 'generate')
      expect(ctx.relevantFiles.length).toBeLessThanOrEqual(20)
    })

    it('includes working state when provided', () => {
      const msgs = makeMessages(['hello', 'world'])
      const state = { phase: 'planning', iteration: 2 }
      const ctx = service.extractContext(msgs, 'plan', state)

      expect(ctx.workingState).toEqual(state)
    })

    it('handles empty messages gracefully', () => {
      const ctx = service.extractContext([], 'unknown')

      expect(ctx.summary).toBe('')
      expect(ctx.decisions).toEqual([])
      expect(ctx.relevantFiles).toEqual([])
      expect(ctx.workingState).toEqual({})
    })
  })

  // -----------------------------------------------------------------------
  // isRelevant
  // -----------------------------------------------------------------------

  describe('isRelevant', () => {
    it('returns true for generate -> edit (default rules)', () => {
      expect(service.isRelevant('generate_feature', 'edit_feature')).toBe(true)
    })

    it('returns true for implement -> debug (default rules)', () => {
      expect(service.isRelevant('implement_auth', 'debug_auth')).toBe(true)
    })

    it('returns true for catch-all rule when no specific match', () => {
      // The default catch-all /.*/ -> /.*/ matches everything
      expect(service.isRelevant('random', 'other')).toBe(true)
    })

    it('returns true when no rules are configured', () => {
      const noRules = new ContextTransferService({ relevanceRules: [] })
      expect(noRules.isRelevant('a', 'b')).toBe(true)
    })

    it('returns false when rules exist but none match', () => {
      const strict = new ContextTransferService({
        relevanceRules: [
          { from: 'generate', to: 'edit', transferScope: 'all', priority: 10 },
        ],
      })
      expect(strict.isRelevant('plan', 'review')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // getTransferScope
  // -----------------------------------------------------------------------

  describe('getTransferScope', () => {
    it('returns "all" for generate -> edit', () => {
      expect(service.getTransferScope('generate_feature', 'edit_component')).toBe('all')
    })

    it('returns "decisions-only" for edit -> generate', () => {
      expect(service.getTransferScope('edit_code', 'generate_module')).toBe('decisions-only')
    })

    it('returns "files-only" for implement -> review', () => {
      expect(service.getTransferScope('implement_auth', 'review_code')).toBe('files-only')
    })

    it('picks the highest priority rule when multiple match', () => {
      // generate -> edit matches both the specific rule (priority 10) and catch-all (priority 1)
      expect(service.getTransferScope('generate_feature', 'edit_feature')).toBe('all')
    })

    it('defaults to summary-only when no rules match', () => {
      const strict = new ContextTransferService({
        relevanceRules: [
          { from: 'generate', to: 'edit', transferScope: 'all', priority: 10 },
        ],
      })
      expect(strict.getTransferScope('unmatched', 'other')).toBe('summary-only')
    })
  })

  // -----------------------------------------------------------------------
  // formatAsMessage
  // -----------------------------------------------------------------------

  describe('formatAsMessage', () => {
    it('produces a SystemMessage with the context', () => {
      const msgs = makeMessages(
        ['Implement login', 'Decided to use JWT. Created src/auth/login.ts and src/auth/jwt.ts.'],
      )
      const ctx = service.extractContext(msgs, 'implement')
      ctx.toIntent = 'debug'

      const sysMsg = service.formatAsMessage(ctx)

      expect(sysMsg).toBeInstanceOf(SystemMessage)
      const content = sysMsg.content as string
      expect(content).toContain('Context Transferred from "implement"')
      expect(content).toContain('Summary')
    })

    it('includes decisions for scope "all"', () => {
      const msgs = makeMessages(
        ['Plan', 'Decided to use Prisma for the ORM layer.'],
      )
      const ctx = service.extractContext(msgs, 'plan')
      ctx.toIntent = 'implement' // plan -> implement = 'all'

      const content = service.formatAsMessage(ctx).content as string
      expect(content).toContain('Key Decisions')
      expect(content).toContain('Prisma')
    })

    it('excludes files for scope "decisions-only"', () => {
      const msgs = makeMessages(
        ['Edit', 'Decided to refactor. Modified src/auth/service.ts.'],
      )
      const ctx = service.extractContext(msgs, 'edit_code')
      ctx.toIntent = 'generate_module'

      const content = service.formatAsMessage(ctx).content as string
      // edit -> generate = decisions-only, so no files section
      expect(content).not.toContain('### Relevant Files')
    })

    it('truncates when exceeding token budget', () => {
      const smallBudget = new ContextTransferService({ maxTransferTokens: 20, charsPerToken: 1 })
      const msgs = makeMessages(
        ['A long conversation about many things', 'With extensive detail about architecture decisions and implementation strategies that goes on and on'],
      )
      const ctx = smallBudget.extractContext(msgs, 'plan')
      ctx.toIntent = 'implement'

      const content = smallBudget.formatAsMessage(ctx).content as string
      expect(content).toContain('[Context truncated to fit token budget]')
    })

    it('includes working state for scope "all"', () => {
      const msgs = makeMessages(['hello', 'world'])
      const ctx = service.extractContext(msgs, 'implement', { phase: 'review' })
      ctx.toIntent = 'debug' // implement -> debug = 'all'

      const content = service.formatAsMessage(ctx).content as string
      expect(content).toContain('Working State')
      expect(content).toContain('"phase": "review"')
    })
  })

  // -----------------------------------------------------------------------
  // injectContext
  // -----------------------------------------------------------------------

  describe('injectContext', () => {
    it('inserts after the first system message', () => {
      const msgs = messagesWithSystem('You are an assistant.', ['Hi', 'Hello'])
      const ctx = service.extractContext(
        makeMessages(['Prev task', 'Done something']),
        'generate',
      )
      ctx.toIntent = 'edit'

      const result = service.injectContext(ctx, msgs)

      // Original had 3 messages (system + human + ai), result has 4
      expect(result.length).toBe(msgs.length + 1)
      expect(result[0]._getType()).toBe('system') // original system
      expect(result[1]._getType()).toBe('system') // injected context
      expect((result[1].content as string)).toContain('Context Transferred')
      expect(result[2]._getType()).toBe('human') // original human
    })

    it('inserts at position 0 if no system message exists', () => {
      const msgs = makeMessages(['Hi', 'Hello'])
      const ctx = service.extractContext(
        makeMessages(['Prev', 'Done']),
        'plan',
      )
      ctx.toIntent = 'implement'

      const result = service.injectContext(ctx, msgs)

      expect(result.length).toBe(msgs.length + 1)
      expect(result[0]._getType()).toBe('system') // injected
      expect(result[1]._getType()).toBe('human')  // original first
    })

    it('does not mutate the input array', () => {
      const msgs = makeMessages(['Hi', 'Hello'])
      const originalLen = msgs.length
      const ctx = service.extractContext(makeMessages(['A', 'B']), 'plan')
      ctx.toIntent = 'implement'

      service.injectContext(ctx, msgs)

      expect(msgs.length).toBe(originalLen)
    })
  })

  // -----------------------------------------------------------------------
  // transfer (full pipeline)
  // -----------------------------------------------------------------------

  describe('transfer', () => {
    it('extracts, checks relevance, and injects context', () => {
      const source = makeMessages(
        ['Build auth', 'Decided to use JWT. Created src/auth/index.ts.'],
      )
      const target = messagesWithSystem('You are a debugger.', ['Auth is broken', 'Let me check'])

      const result = service.transfer(source, 'implement_auth', target, 'debug_auth')

      expect(result).not.toBeNull()
      expect(result!.length).toBe(target.length + 1)
      const injected = result![1].content as string
      expect(injected).toContain('Context Transferred from "implement_auth"')
    })

    it('returns null when transfer is not relevant', () => {
      const strict = new ContextTransferService({
        relevanceRules: [
          { from: 'generate', to: 'edit', transferScope: 'all', priority: 10 },
        ],
      })
      const result = strict.transfer(
        makeMessages(['A', 'B']),
        'unrelated',
        makeMessages(['C', 'D']),
        'other',
      )
      expect(result).toBeNull()
    })

    it('passes working state through to the context', () => {
      const source = makeMessages(['Plan DB', 'Will use Postgres.'])
      const target = messagesWithSystem('System', ['Implement', 'Starting'])
      const state = { dbEngine: 'postgres', schema: 'v2' }

      const result = service.transfer(source, 'plan_db', target, 'implement_db', state)

      expect(result).not.toBeNull()
      // Find the injected system message
      const injected = result![1].content as string
      expect(injected).toContain('Context Transferred')
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles messages with array content', () => {
      const msg = new HumanMessage({
        content: [
          { type: 'text' as const, text: 'Check src/utils/helpers.ts for the decided approach' },
        ],
      })
      const ctx = service.extractContext([msg], 'review')

      expect(ctx.relevantFiles).toContain('src/utils/helpers.ts')
      expect(ctx.decisions.length).toBeGreaterThanOrEqual(1)
    })

    it('handles custom string-based relevance rules', () => {
      const custom = new ContextTransferService({
        relevanceRules: [
          { from: 'alpha', to: 'beta', transferScope: 'files-only', priority: 5 },
        ],
      })

      expect(custom.isRelevant('alpha', 'beta')).toBe(true)
      expect(custom.isRelevant('alpha', 'gamma')).toBe(false)
      expect(custom.getTransferScope('alpha', 'beta')).toBe('files-only')
    })
  })
})
