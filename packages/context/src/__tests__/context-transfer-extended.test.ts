import { describe, it, expect, beforeEach } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  ContextTransferService,
  type ContextTransferConfig,
  type IntentContext,
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
// Extended context extraction tests
// ---------------------------------------------------------------------------

describe('ContextTransferService — extended', () => {
  let service: ContextTransferService

  beforeEach(() => {
    service = new ContextTransferService()
  })

  // -----------------------------------------------------------------------
  // Context serialization & deserialization
  // -----------------------------------------------------------------------

  describe('context serialization', () => {
    it('produces a JSON-serializable IntentContext', () => {
      const msgs = makeMessages(
        ['Build feature', 'Decided to use React. Modified src/app/index.tsx.'],
      )
      const ctx = service.extractContext(msgs, 'implement', { step: 1 })

      const serialized = JSON.stringify(ctx)
      const deserialized = JSON.parse(serialized) as IntentContext

      expect(deserialized.fromIntent).toBe('implement')
      expect(deserialized.decisions.length).toBeGreaterThanOrEqual(1)
      expect(deserialized.relevantFiles).toContain('src/app/index.tsx')
      expect(deserialized.workingState).toEqual({ step: 1 })
      expect(deserialized.transferredAt).toBeGreaterThan(0)
      expect(deserialized.tokenEstimate).toBeGreaterThan(0)
    })

    it('roundtrips through formatAsMessage and back to string', () => {
      const msgs = makeMessages(
        ['Setup DB', 'Decided to use Prisma for ORM. Created src/db/schema.ts.'],
      )
      const ctx = service.extractContext(msgs, 'plan')
      ctx.toIntent = 'implement'

      const sysMsg = service.formatAsMessage(ctx)
      const content = sysMsg.content as string

      expect(content).toContain('Context Transferred from "plan"')
      expect(content).toContain('Summary')
      expect(content).toContain('Prisma')
      expect(content).toContain('src/db/schema.ts')
    })
  })

  // -----------------------------------------------------------------------
  // Selective transfer (filter by scope)
  // -----------------------------------------------------------------------

  describe('selective transfer by scope', () => {
    it('summary-only scope excludes decisions and files', () => {
      const msgs = makeMessages(
        ['Build auth', 'Decided to use JWT. Created src/auth/jwt.ts.'],
      )
      const ctx = service.extractContext(msgs, 'random_task')
      ctx.toIntent = 'other_task'

      // random -> other falls through to catch-all: summary-only
      const content = service.formatAsMessage(ctx).content as string

      expect(content).toContain('Summary')
      expect(content).not.toContain('### Key Decisions')
      expect(content).not.toContain('### Relevant Files')
      expect(content).not.toContain('### Working State')
    })

    it('decisions-only scope includes decisions but not files', () => {
      const msgs = makeMessages(
        ['Edit code', 'Decided to refactor auth. Modified src/auth/index.ts.'],
      )
      const ctx = service.extractContext(msgs, 'edit_feature')
      ctx.toIntent = 'generate_feature'

      // edit -> generate = decisions-only
      const content = service.formatAsMessage(ctx).content as string

      expect(content).toContain('Summary')
      expect(content).toContain('Key Decisions')
      expect(content).not.toContain('### Relevant Files')
    })

    it('files-only scope includes files but not decisions', () => {
      const msgs = makeMessages(
        ['Implement auth', 'Decided to use JWT. Created src/auth/service.ts.'],
      )
      const ctx = service.extractContext(msgs, 'implement_auth')
      ctx.toIntent = 'review_code'

      // implement -> review = files-only
      const content = service.formatAsMessage(ctx).content as string

      expect(content).toContain('Summary')
      expect(content).toContain('Relevant Files')
      expect(content).not.toContain('### Key Decisions')
    })

    it('all scope includes everything', () => {
      const msgs = makeMessages(
        ['Plan DB', 'Decided to use Postgres. Created src/db/schema.ts.'],
      )
      const ctx = service.extractContext(msgs, 'plan_db', { engine: 'pg' })
      ctx.toIntent = 'implement_db'

      // plan -> implement = all
      const content = service.formatAsMessage(ctx).content as string

      expect(content).toContain('Summary')
      expect(content).toContain('Key Decisions')
      expect(content).toContain('Relevant Files')
      expect(content).toContain('Working State')
      expect(content).toContain('"engine": "pg"')
    })

    it('all scope omits working state section when empty', () => {
      const msgs = makeMessages(
        ['Plan DB', 'Decided to use Postgres.'],
      )
      const ctx = service.extractContext(msgs, 'plan_db')
      ctx.toIntent = 'implement_db'

      const content = service.formatAsMessage(ctx).content as string

      expect(content).not.toContain('### Working State')
    })
  })

  // -----------------------------------------------------------------------
  // Context merging strategies (multiple transfers)
  // -----------------------------------------------------------------------

  describe('context merging — multiple injections', () => {
    it('can inject context from multiple sources sequentially', () => {
      const source1 = makeMessages(['Build auth', 'Used JWT'])
      const source2 = makeMessages(['Setup DB', 'Used Prisma'])
      const target = messagesWithSystem('You are a debugger', ['Fix bug', 'Looking'])

      const ctx1 = service.extractContext(source1, 'implement_auth')
      ctx1.toIntent = 'debug'
      const ctx2 = service.extractContext(source2, 'implement_db')
      ctx2.toIntent = 'debug'

      // Inject first context
      const after1 = service.injectContext(ctx1, target)
      // Inject second context into the already-augmented array
      const after2 = service.injectContext(ctx2, after1)

      expect(after2.length).toBe(target.length + 2)

      // Both contexts should be present
      const systemMsgs = after2.filter(m => m._getType() === 'system')
      const contents = systemMsgs.map(m => m.content as string)
      expect(contents.some(c => c.includes('implement_auth'))).toBe(true)
      expect(contents.some(c => c.includes('implement_db'))).toBe(true)
    })

    it('injection preserves message ordering', () => {
      const source = makeMessages(['Source task', 'Done'])
      const target = messagesWithSystem('System', ['Q1', 'A1'], ['Q2', 'A2'])

      const ctx = service.extractContext(source, 'generate')
      ctx.toIntent = 'edit'

      const result = service.injectContext(ctx, target)

      // Order: system, injected-system, human, ai, human, ai
      expect(result[0]!._getType()).toBe('system')
      expect((result[0]!.content as string)).toBe('System')
      expect(result[1]!._getType()).toBe('system')
      expect((result[1]!.content as string)).toContain('Context Transferred')
      expect(result[2]!._getType()).toBe('human')
      expect(result[3]!._getType()).toBe('ai')
      expect(result[4]!._getType()).toBe('human')
      expect(result[5]!._getType()).toBe('ai')
    })
  })

  // -----------------------------------------------------------------------
  // Transfer with tool messages
  // -----------------------------------------------------------------------

  describe('transfer with tool messages', () => {
    it('extracts decisions from tool messages', () => {
      const msgs: BaseMessage[] = [
        new HumanMessage('check'),
        new AIMessage({
          content: 'Decided to use Redis for caching',
          tool_calls: [{ id: 'tc-1', name: 'read_file', args: {} }],
        }),
        new ToolMessage({ content: 'file contents here', tool_call_id: 'tc-1' }),
      ]

      const ctx = service.extractContext(msgs, 'implement')

      // Decisions can come from AI messages
      expect(ctx.decisions.some(d => /Redis/.test(d))).toBe(true)
    })

    it('filters out tool messages from summary (only human+ai)', () => {
      const msgs: BaseMessage[] = [
        new HumanMessage('Build it'),
        new AIMessage({
          content: 'calling tool',
          tool_calls: [{ id: 'tc-1', name: 'test', args: {} }],
        }),
        new ToolMessage({
          content: 'this is a very long tool result that should not appear in summary',
          tool_call_id: 'tc-1',
        }),
        new AIMessage('Done building'),
      ]

      const ctx = service.extractContext(msgs, 'implement')

      // Summary should only have human + ai messages
      expect(ctx.summary).toContain('[human]')
      expect(ctx.summary).toContain('[ai]')
      expect(ctx.summary).not.toContain('[tool]')
    })
  })

  // -----------------------------------------------------------------------
  // Token budget enforcement
  // -----------------------------------------------------------------------

  describe('token budget enforcement', () => {
    it('truncates context when exceeding maxTransferTokens', () => {
      const smallBudget = new ContextTransferService({
        maxTransferTokens: 10,
        charsPerToken: 1,
      })

      const msgs = makeMessages(
        ['Build a very large feature with many requirements', 'Here is a comprehensive plan with extensive details about the implementation approach'],
      )
      const ctx = smallBudget.extractContext(msgs, 'plan')
      ctx.toIntent = 'implement'

      const content = smallBudget.formatAsMessage(ctx).content as string

      expect(content).toContain('[Context truncated to fit token budget]')
      // Total length should be close to maxTransferTokens * charsPerToken + truncation notice
      expect(content.length).toBeLessThan(200) // 10 chars + truncation notice
    })

    it('does not truncate when within budget', () => {
      const largeBudget = new ContextTransferService({
        maxTransferTokens: 100_000,
      })

      const msgs = makeMessages(['Short', 'Reply'])
      const ctx = largeBudget.extractContext(msgs, 'plan')
      ctx.toIntent = 'implement'

      const content = largeBudget.formatAsMessage(ctx).content as string

      expect(content).not.toContain('[Context truncated')
    })

    it('token estimate reflects actual formatted content size', () => {
      const msgs = makeMessages(
        ['Build auth module', 'Decided to use JWT for authentication. Created src/auth/jwt.ts.'],
      )
      const ctx = service.extractContext(msgs, 'implement')

      // tokenEstimate should be positive and roughly proportional to content
      expect(ctx.tokenEstimate).toBeGreaterThan(0)
      // With default charsPerToken=4, estimate = ceil(formatted.length / 4)
      expect(ctx.tokenEstimate).toBeLessThan(10_000) // sanity check
    })
  })

  // -----------------------------------------------------------------------
  // Custom relevance rules
  // -----------------------------------------------------------------------

  describe('custom relevance rules', () => {
    it('supports exact string matching for from/to', () => {
      const custom = new ContextTransferService({
        relevanceRules: [
          { from: 'deploy', to: 'monitor', transferScope: 'all', priority: 10 },
        ],
      })

      expect(custom.isRelevant('deploy', 'monitor')).toBe(true)
      expect(custom.isRelevant('deploy', 'debug')).toBe(false)
      expect(custom.isRelevant('deploy_prod', 'monitor')).toBe(false)
    })

    it('supports regex matching for from/to', () => {
      const custom = new ContextTransferService({
        relevanceRules: [
          { from: /^deploy/, to: /monitor|observe/, transferScope: 'files-only', priority: 5 },
        ],
      })

      expect(custom.isRelevant('deploy_prod', 'monitor_health')).toBe(true)
      expect(custom.isRelevant('deploy_staging', 'observe_metrics')).toBe(true)
      expect(custom.isRelevant('build', 'monitor_health')).toBe(false)
    })

    it('picks highest priority rule when multiple match', () => {
      const custom = new ContextTransferService({
        relevanceRules: [
          { from: /.*/, to: /.*/, transferScope: 'summary-only', priority: 1 },
          { from: /plan/, to: /implement/, transferScope: 'all', priority: 10 },
          { from: /plan/, to: /.*/, transferScope: 'decisions-only', priority: 5 },
        ],
      })

      // plan -> implement: matches all three rules, highest priority (10) = 'all'
      expect(custom.getTransferScope('plan_db', 'implement_db')).toBe('all')
      // plan -> review: matches catch-all (1) and plan->* (5), highest = 'decisions-only'
      expect(custom.getTransferScope('plan_auth', 'review_auth')).toBe('decisions-only')
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles very long messages by capping content preview to 200 chars', () => {
      const longContent = 'A'.repeat(500)
      const msgs = makeMessages([longContent, longContent])
      const ctx = service.extractContext(msgs, 'test')

      // Each message in summary should be capped at 200 chars
      const lines = ctx.summary.split('\n')
      for (const line of lines) {
        if (line.startsWith('[')) {
          // [role]: content — content should be at most 200 chars
          const contentPart = line.replace(/^\[(?:human|ai)\]: /, '')
          expect(contentPart.length).toBeLessThanOrEqual(200)
        }
      }
    })

    it('handles messages with only tool messages (no human/ai)', () => {
      const msgs: BaseMessage[] = [
        new ToolMessage({ content: 'result', tool_call_id: 'tc-1' }),
      ]

      const ctx = service.extractContext(msgs, 'unknown')

      // No human/ai messages to summarize
      expect(ctx.summary).toBe('')
      expect(ctx.decisions).toEqual([])
    })

    it('handles messages with Unicode content', () => {
      const msgs = makeMessages(
        ['Erstelle eine Funktion', 'Decided to use Prisma. Die Datei ist src/db/schema.ts.'],
      )
      const ctx = service.extractContext(msgs, 'implement')

      expect(ctx.summary).toContain('Erstelle')
      expect(ctx.relevantFiles).toContain('src/db/schema.ts')
    })

    it('handles system messages in the source (filtered out of summary)', () => {
      const msgs: BaseMessage[] = [
        new SystemMessage('You are a helpful assistant'),
        new HumanMessage('Build auth'),
        new AIMessage('Decided to use JWT. Created src/auth/index.ts.'),
      ]

      const ctx = service.extractContext(msgs, 'implement')

      // Summary only includes human + ai
      expect(ctx.summary).toContain('[human]')
      expect(ctx.summary).toContain('[ai]')
      expect(ctx.summary).not.toContain('[system]')
    })

    it('transfers with empty target messages', () => {
      const source = makeMessages(['Build it', 'Done'])
      const target: BaseMessage[] = []

      const result = service.transfer(source, 'implement', target, 'debug')

      expect(result).not.toBeNull()
      expect(result!.length).toBe(1) // just the injected system message
      expect(result![0]!._getType()).toBe('system')
    })

    it('transfers with empty source messages', () => {
      const source: BaseMessage[] = []
      const target = messagesWithSystem('System', ['Q', 'A'])

      const result = service.transfer(source, 'implement', target, 'debug')

      expect(result).not.toBeNull()
      // Context is injected even with empty source (summary will be empty)
      expect(result!.length).toBe(target.length + 1)
    })

    it('extractContext caps recent messages to RECENT_MESSAGE_PAIRS (6)', () => {
      // Create 20 human/ai messages
      const msgs: BaseMessage[] = []
      for (let i = 0; i < 20; i++) {
        msgs.push(new HumanMessage(`Q${i}`))
        msgs.push(new AIMessage(`A${i}`))
      }

      const ctx = service.extractContext(msgs, 'test')

      // Summary should only include last 6 conversational messages
      const summaryLines = ctx.summary.split('\n').filter(l => l.startsWith('['))
      expect(summaryLines.length).toBeLessThanOrEqual(6)
    })

    it('formatAsMessage uses "all" scope when toIntent is empty', () => {
      const msgs = makeMessages(
        ['Plan', 'Decided to use Prisma. Created src/db/schema.ts.'],
      )
      const ctx = service.extractContext(msgs, 'plan', { step: 1 })
      // toIntent is '' (empty) from extractContext

      const content = service.formatAsMessage(ctx).content as string

      // With empty toIntent, scope defaults to 'all'
      expect(content).toContain('Summary')
      expect(content).toContain('Key Decisions')
      expect(content).toContain('Relevant Files')
      expect(content).toContain('Working State')
    })

    it('decision patterns match various phrasings', () => {
      const testCases = [
        'Decided to use TypeScript strict mode',
        'Going with React for the frontend',
        'Chosen approach: microservices architecture',
        'Settled on PostgreSQL for the database',
        'Will use Docker for deployment',
        'Architecture: monorepo with turborepo',
      ]

      for (const phrase of testCases) {
        const msgs: BaseMessage[] = [new AIMessage(phrase)]
        const ctx = service.extractContext(msgs, 'test')
        expect(ctx.decisions.length).toBeGreaterThanOrEqual(1,
          `Expected decision extraction for: "${phrase}"`)
      }
    })

    it('is idempotent when injecting the same context twice', () => {
      const source = makeMessages(['Plan', 'Decided to use Prisma. Created src/db/schema.ts.'])
      const target = messagesWithSystem('System', ['Q', 'A'])

      const ctx = service.extractContext(source, 'plan')
      ctx.toIntent = 'implement'

      const once = service.injectContext(ctx, target)
      const twice = service.injectContext(ctx, once)

      // Second injection must be a no-op: length and content identical
      expect(twice.length).toBe(once.length)
      expect(twice.map(m => m._getType())).toEqual(once.map(m => m._getType()))
      for (let i = 0; i < once.length; i++) {
        expect(twice[i]!.content).toEqual(once[i]!.content)
      }

      // Exactly one injected transfer marker
      const injected = twice.filter(m =>
        m._getType() === 'system' &&
        typeof m.content === 'string' &&
        m.content.startsWith('## Context Transferred from "plan"'),
      )
      expect(injected.length).toBe(1)
    })

    it('still injects when a different source intent is already present', () => {
      const source1 = makeMessages(['Plan A', 'decided to use A'])
      const source2 = makeMessages(['Plan B', 'decided to use B'])
      const target = messagesWithSystem('System', ['Q', 'A'])

      const ctx1 = service.extractContext(source1, 'plan_a')
      ctx1.toIntent = 'implement'
      const ctx2 = service.extractContext(source2, 'plan_b')
      ctx2.toIntent = 'implement'

      const after1 = service.injectContext(ctx1, target)
      const after2 = service.injectContext(ctx2, after1)

      // Distinct source intents should both be injected
      expect(after2.length).toBe(target.length + 2)
    })

    it('file path extraction handles various formats', () => {
      const content = `
        Modified src/auth/service.ts
        Created packages/core/index.ts
        See config/database.yaml
        Check lib/utils/helpers.js
      `
      const msgs: BaseMessage[] = [new AIMessage(content)]
      const ctx = service.extractContext(msgs, 'test')

      expect(ctx.relevantFiles).toContain('src/auth/service.ts')
      expect(ctx.relevantFiles).toContain('packages/core/index.ts')
      expect(ctx.relevantFiles).toContain('config/database.yaml')
      expect(ctx.relevantFiles).toContain('lib/utils/helpers.js')
    })
  })
})
