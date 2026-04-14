import { describe, expect, it } from 'vitest'

import {
  SystemPromptBuilder,
  type ClaudeAppendPayload,
  type CodexPromptPayload,
} from '../prompts/system-prompt-builder.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuilder(text = 'Be concise.', opts?: ConstructorParameters<typeof SystemPromptBuilder>[1]) {
  return new SystemPromptBuilder(text, opts)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SystemPromptBuilder', () => {
  describe('constructor', () => {
    it('stores system prompt text', () => {
      const b = makeBuilder('Hello world')
      expect(b.rawText).toBe('Hello world')
    })

    it('throws when systemPrompt is empty string', () => {
      expect(() => new SystemPromptBuilder('')).toThrow('non-empty string')
    })

    it('throws when systemPrompt is only whitespace', () => {
      expect(() => new SystemPromptBuilder('   ')).toThrow('non-empty string')
    })
  })

  describe('buildFor("claude") — default append mode', () => {
    it('returns a preset append object', () => {
      const payload = makeBuilder().buildFor('claude') as ClaudeAppendPayload
      expect(payload).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'Be concise.',
      })
    })

    it('buildForClaude() returns same value', () => {
      const b = makeBuilder('Short answers.')
      expect(b.buildForClaude()).toEqual(b.buildFor('claude'))
    })

    it('explicit claudeMode append produces preset object', () => {
      const payload = makeBuilder('Test.', { claudeMode: 'append' }).buildFor('claude') as ClaudeAppendPayload
      expect(payload.type).toBe('preset')
      expect(payload.preset).toBe('claude_code')
      expect(payload.append).toBe('Test.')
    })
  })

  describe('buildFor("claude") — replace mode', () => {
    it('returns raw string when claudeMode is replace', () => {
      const payload = makeBuilder('Custom system.', { claudeMode: 'replace' }).buildFor('claude')
      expect(payload).toBe('Custom system.')
    })
  })

  describe('buildFor("codex")', () => {
    it('returns instructions-only object', () => {
      const payload = makeBuilder().buildFor('codex') as CodexPromptPayload
      expect(payload).toEqual({ instructions: 'Be concise.' })
    })

    it('includes developer_instructions when option is set', () => {
      const payload = makeBuilder('User instructions.', {
        codexDeveloperInstructions: 'Use JSON output.',
      }).buildFor('codex') as CodexPromptPayload
      expect(payload.instructions).toBe('User instructions.')
      expect(payload.developer_instructions).toBe('Use JSON output.')
    })

    it('does not include developer_instructions when option is empty', () => {
      const payload = makeBuilder().buildFor('codex') as CodexPromptPayload
      expect(payload.developer_instructions).toBeUndefined()
    })

    it('buildForCodex() returns same value as buildFor("codex")', () => {
      const b = makeBuilder('Prompt.')
      expect(b.buildForCodex()).toEqual(b.buildFor('codex'))
    })
  })

  describe('buildFor — generic providers (plain string)', () => {
    const PLAIN_STRING_PROVIDERS = ['gemini', 'gemini-sdk', 'qwen', 'crush', 'goose', 'openrouter'] as const

    for (const provider of PLAIN_STRING_PROVIDERS) {
      it(`returns raw string for provider "${provider}"`, () => {
        const payload = makeBuilder('Short.').buildFor(provider)
        expect(payload).toBe('Short.')
      })
    }
  })

  describe('rawText', () => {
    it('returns the original system prompt text', () => {
      expect(makeBuilder('Original text.').rawText).toBe('Original text.')
    })
  })
})
