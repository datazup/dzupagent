import { describe, it, expect, vi } from 'vitest'
import { WorkflowCommandParser } from '../skills/workflow-command-parser.js'
import type {
  WorkflowCommandParseSuccess,
  WorkflowCommandParseFailure,
} from '../skills/workflow-command-parser.js'
import type { IntentRouter } from '../router/intent-router.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(result: ReturnType<WorkflowCommandParser['parse']>): WorkflowCommandParseSuccess {
  expect(result.ok).toBe(true)
  return result as WorkflowCommandParseSuccess
}

function fail(result: ReturnType<WorkflowCommandParser['parse']>): WorkflowCommandParseFailure {
  expect(result.ok).toBe(false)
  return result as WorkflowCommandParseFailure
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowCommandParser', () => {
  describe('parse()', () => {
    it('returns failure for empty string', () => {
      const parser = new WorkflowCommandParser()
      const result = fail(parser.parse(''))
      expect(result.reason).toMatch(/[Ee]mpty/)
    })

    it('parses arrow separator (unicode)', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('brainstorm \u2192 spec'))
      expect(result.steps).toHaveLength(2)
      expect(result.separatorStyle).toBe('arrow')
      expect(result.confidence).toBe('keyword')
      expect(result.steps[0]!.normalized).toBe('brainstorm')
      expect(result.steps[1]!.normalized).toBe('spec')
    })

    it('parses arrow separator (ASCII ->)', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('brainstorm -> spec'))
      expect(result.steps).toHaveLength(2)
      expect(result.separatorStyle).toBe('arrow')
      expect(result.confidence).toBe('keyword')
    })

    it('parses pipe separator', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('a | b | c'))
      expect(result.steps).toHaveLength(3)
      expect(result.separatorStyle).toBe('pipe')
    })

    it('parses comma separator', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('a, b'))
      expect(result.steps).toHaveLength(2)
      expect(result.separatorStyle).toBe('comma')
    })

    it('parses then-keyword separator', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('a then b'))
      expect(result.steps).toHaveLength(2)
      expect(result.separatorStyle).toBe('then-keyword')
    })

    it('strips sc: prefix during normalization', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('sc:brainstorm \u2192 sc:spec'))
      expect(result.steps[0]!.normalized).toBe('brainstorm')
      expect(result.steps[1]!.normalized).toBe('spec')
    })

    it('returns single token with separatorStyle "unknown" and confidence "default"', () => {
      const parser = new WorkflowCommandParser()
      const result = ok(parser.parse('brainstorm'))
      expect(result.steps).toHaveLength(1)
      expect(result.separatorStyle).toBe('unknown')
      expect(result.confidence).toBe('default')
    })
  })

  describe('aliases', () => {
    it('resolves an alias added via addAlias()', () => {
      const parser = new WorkflowCommandParser()
      parser.addAlias('full-flow', ['brainstorm', 'spec'])

      const result = ok(parser.parse('full-flow'))
      expect(result.separatorStyle).toBe('alias')
      expect(result.confidence).toBe('heuristic')
      expect(result.steps).toHaveLength(2)
      expect(result.steps[0]!.normalized).toBe('brainstorm')
      expect(result.steps[1]!.normalized).toBe('spec')
    })

    it('listAliases() returns registered aliases', () => {
      const parser = new WorkflowCommandParser()
      parser.addAlias('flow-a', ['a', 'b'])
      parser.addAlias('flow-b', ['c'])

      const aliases = parser.listAliases()
      expect(aliases).toHaveLength(2)
      expect(aliases.map((a) => a.name)).toContain('flow-a')
      expect(aliases.map((a) => a.name)).toContain('flow-b')
    })

    it('alias lookup is case-insensitive', () => {
      const parser = new WorkflowCommandParser()
      parser.addAlias('Full-Flow', ['a', 'b'])

      const result = ok(parser.parse('full-flow'))
      expect(result.separatorStyle).toBe('alias')
    })
  })

  describe('parseAsync()', () => {
    it('returns LLM-backed result when sync parse fails and IntentRouter succeeds', async () => {
      const mockRouter = {
        classify: vi.fn().mockResolvedValue({
          intent: 'brainstorm',
          confidence: 'heuristic' as const,
        }),
      } as unknown as IntentRouter

      const parser = new WorkflowCommandParser({ intentRouter: mockRouter })

      // Create a scenario where sync parse fails: input that normalizes to empty
      // Actually, the sync parse will succeed for any non-empty string (single-token path).
      // We need to force a sync failure. The only way is empty input, but that fails async too.
      // Instead, use a custom normalizer that returns empty to force sync failure.
      const failParser = new WorkflowCommandParser({
        intentRouter: mockRouter,
        normalizer: () => '',
      })

      const result = await failParser.parseAsync('something weird')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.confidence).toBe('llm')
        expect(result.steps[0]!.raw).toBe('brainstorm')
      }
    })

    it('returns original failure when IntentRouter throws', async () => {
      const mockRouter = {
        classify: vi.fn().mockRejectedValue(new Error('LLM down')),
      } as unknown as IntentRouter

      const logger = { warn: vi.fn() }

      const failParser = new WorkflowCommandParser({
        intentRouter: mockRouter,
        normalizer: () => '',
        logger,
      })

      const result = await failParser.parseAsync('something weird')
      expect(result.ok).toBe(false)
      expect(logger.warn).toHaveBeenCalled()
    })

    it('returns original failure when IntentRouter returns default confidence', async () => {
      const mockRouter = {
        classify: vi.fn().mockResolvedValue({
          intent: 'unknown',
          confidence: 'default' as const,
        }),
      } as unknown as IntentRouter

      const failParser = new WorkflowCommandParser({
        intentRouter: mockRouter,
        normalizer: () => '',
      })

      const result = await failParser.parseAsync('something weird')
      expect(result.ok).toBe(false)
    })
  })

  describe('configuration', () => {
    it('throws on invalid regex pattern', () => {
      expect(
        () =>
          new WorkflowCommandParser({
            keywordPatterns: [{ pattern: '[invalid(', impliedSeparator: 'arrow' }],
          }),
      ).toThrow(/Invalid regex/)
    })

    it('uses custom normalizer', () => {
      const parser = new WorkflowCommandParser({
        normalizer: (s: string) => s.trim().toUpperCase(),
      })
      const result = ok(parser.parse(' brainstorm '))
      expect(result.steps[0]!.normalized).toBe('BRAINSTORM')
    })
  })

  describe('ReDoS defense', () => {
    it('throws on nested quantifier pattern', () => {
      expect(() => new WorkflowCommandParser({
        keywordPatterns: [{ pattern: '(a+)+', impliedSeparator: 'arrow' }],
      })).toThrow(/nested quantifiers/)
    })

    it('throws on alternation with quantifier pattern', () => {
      expect(() => new WorkflowCommandParser({
        keywordPatterns: [{ pattern: '(a|ab)+', impliedSeparator: 'pipe' }],
      })).toThrow(/alternation with quantifier/)
    })

    it('does not throw on safe patterns', () => {
      expect(() => new WorkflowCommandParser({
        keywordPatterns: [{ pattern: 'then', impliedSeparator: 'then-keyword' }],
      })).not.toThrow()
    })
  })
})
