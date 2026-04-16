import { describe, it, expect, beforeEach } from 'vitest'
import { OpenAICompletionMapper } from '../completion-mapper.js'
import type { ChatCompletionRequest } from '../types.js'

describe('OpenAICompletionMapper', () => {
  let sut: OpenAICompletionMapper

  beforeEach(() => {
    sut = new OpenAICompletionMapper()
  })

  // ---------------------------------------------------------------------------
  // mapRequest
  // ---------------------------------------------------------------------------

  describe('mapRequest', () => {
    const baseRequest: ChatCompletionRequest = {
      model: 'my-agent',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello!' },
      ],
    }

    it('should flatten messages into a prompt string with role prefixes', () => {
      const result = sut.mapRequest(baseRequest)

      expect(result.prompt).toContain('System: You are helpful.')
      expect(result.prompt).toContain('User: Hello!')
      // Messages are separated by double newlines
      expect(result.prompt).toBe('System: You are helpful.\n\nUser: Hello!')
    })

    it('should extract agentId from the model field', () => {
      const result = sut.mapRequest(baseRequest)

      expect(result.agentId).toBe('my-agent')
    })

    it('should pass through temperature when provided', () => {
      const result = sut.mapRequest({ ...baseRequest, temperature: 0.7 })

      expect(result.options.temperature).toBe(0.7)
    })

    it('should pass through max_tokens as maxTokens', () => {
      const result = sut.mapRequest({ ...baseRequest, max_tokens: 512 })

      expect(result.options.maxTokens).toBe(512)
    })

    it('should pass through stop sequences', () => {
      const result = sut.mapRequest({ ...baseRequest, stop: ['END', 'STOP'] })

      expect(result.options.stop).toEqual(['END', 'STOP'])
    })

    it('should omit optional fields from options when not provided', () => {
      const result = sut.mapRequest(baseRequest)

      expect(result.options).toEqual({})
    })

    it('should handle messages with null content', () => {
      const req: ChatCompletionRequest = {
        model: 'agent-1',
        messages: [{ role: 'assistant', content: null }],
      }

      const result = sut.mapRequest(req)

      expect(result.prompt).toBe('Assistant: ')
    })

    it('should capitalise all role names in the prompt', () => {
      const req: ChatCompletionRequest = {
        model: 'agent-1',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'usr' },
          { role: 'assistant', content: 'ast' },
          { role: 'tool', content: 'tl' },
        ],
      }

      const result = sut.mapRequest(req)

      expect(result.prompt).toContain('System: sys')
      expect(result.prompt).toContain('User: usr')
      expect(result.prompt).toContain('Assistant: ast')
      expect(result.prompt).toContain('Tool: tl')
    })
  })

  // ---------------------------------------------------------------------------
  // mapResponse
  // ---------------------------------------------------------------------------

  describe('mapResponse', () => {
    it('should return a valid ChatCompletionResponse shape', () => {
      const response = sut.mapResponse('agent-1', 'Hello world', 'agent-1', 'chatcmpl-abc123')

      expect(response).toEqual(
        expect.objectContaining({
          id: 'chatcmpl-abc123',
          object: 'chat.completion',
          model: 'agent-1',
        }),
      )
      expect(typeof response.created).toBe('number')
      expect(response.choices).toHaveLength(1)
      expect(response.usage).toBeDefined()
    })

    it('should set choices[0].message.role to assistant', () => {
      const response = sut.mapResponse('agent-1', 'test', 'agent-1', 'id-1')

      expect(response.choices[0]!.message.role).toBe('assistant')
    })

    it('should set choices[0].message.content to the output', () => {
      const response = sut.mapResponse('agent-1', 'the output', 'agent-1', 'id-1')

      expect(response.choices[0]!.message.content).toBe('the output')
    })

    it('should set choices[0].finish_reason to stop', () => {
      const response = sut.mapResponse('agent-1', 'test', 'agent-1', 'id-1')

      expect(response.choices[0]!.finish_reason).toBe('stop')
    })

    it('should compute total_tokens as prompt_tokens + completion_tokens', () => {
      const response = sut.mapResponse('agent-1', 'test output', 'agent-1', 'id-1')

      expect(response.usage.total_tokens).toBe(
        response.usage.prompt_tokens + response.usage.completion_tokens,
      )
    })

    it('should estimate tokens using the chars/4 heuristic (Math.ceil)', () => {
      // agentId = "agent-1" -> 7 chars -> ceil(7/4) = 2 prompt tokens
      // output = "12345678" -> 8 chars -> ceil(8/4) = 2 completion tokens
      const response = sut.mapResponse('agent-1', '12345678', 'agent-1', 'id-1')

      expect(response.usage.prompt_tokens).toBe(Math.ceil('agent-1'.length / 4))
      expect(response.usage.completion_tokens).toBe(Math.ceil('12345678'.length / 4))
    })

    it('should set created to a unix timestamp (seconds)', () => {
      const before = Math.floor(Date.now() / 1000)
      const response = sut.mapResponse('agent-1', 'test', 'agent-1', 'id-1')
      const after = Math.floor(Date.now() / 1000)

      expect(response.created).toBeGreaterThanOrEqual(before)
      expect(response.created).toBeLessThanOrEqual(after)
    })
  })

  // ---------------------------------------------------------------------------
  // mapChunk
  // ---------------------------------------------------------------------------

  describe('mapChunk', () => {
    it('should return a valid ChatCompletionChunk shape', () => {
      const chunk = sut.mapChunk('hello', 'agent-1', 'chatcmpl-xyz', 0, false)

      expect(chunk).toEqual(
        expect.objectContaining({
          id: 'chatcmpl-xyz',
          object: 'chat.completion.chunk',
          model: 'agent-1',
        }),
      )
      expect(typeof chunk.created).toBe('number')
      expect(chunk.choices).toHaveLength(1)
    })

    it('should set object to chat.completion.chunk', () => {
      const chunk = sut.mapChunk('hello', 'agent-1', 'id-1', 0, false)

      expect(chunk.object).toBe('chat.completion.chunk')
    })

    it('should set finish_reason to null for non-last chunks', () => {
      const chunk = sut.mapChunk('hello', 'agent-1', 'id-1', 0, false)

      expect(chunk.choices[0]!.finish_reason).toBeNull()
    })

    it('should set finish_reason to stop for the last chunk', () => {
      const chunk = sut.mapChunk('', 'agent-1', 'id-1', 0, true)

      expect(chunk.choices[0]!.finish_reason).toBe('stop')
    })

    it('should include delta.content for non-last chunks', () => {
      const chunk = sut.mapChunk('world', 'agent-1', 'id-1', 0, false)

      expect(chunk.choices[0]!.delta.content).toBe('world')
      expect(chunk.choices[0]!.delta.role).toBe('assistant')
    })

    it('should have an empty delta for the last chunk', () => {
      const chunk = sut.mapChunk('', 'agent-1', 'id-1', 0, true)

      expect(chunk.choices[0]!.delta).toEqual({})
    })

    it('should propagate the choice index', () => {
      const chunk = sut.mapChunk('text', 'agent-1', 'id-1', 3, false)

      expect(chunk.choices[0]!.index).toBe(3)
    })
  })

  // ---------------------------------------------------------------------------
  // generateId
  // ---------------------------------------------------------------------------

  describe('generateId', () => {
    it('should return a string starting with chatcmpl-', () => {
      const id = sut.generateId()

      expect(id).toMatch(/^chatcmpl-/)
    })

    it('should return a string of the expected length (chatcmpl- prefix + 24 chars)', () => {
      const id = sut.generateId()

      // "chatcmpl-" is 9 chars, plus 24 random chars = 33
      expect(id).toHaveLength(9 + 24)
    })

    it('should generate unique IDs on successive calls', () => {
      const ids = new Set(Array.from({ length: 50 }, () => sut.generateId()))

      expect(ids.size).toBe(50)
    })
  })
})
