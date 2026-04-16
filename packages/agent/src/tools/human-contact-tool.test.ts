import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createHumanContactTool,
  InMemoryPendingContactStore,
  type PendingContactStore,
  type HumanContactToolConfig,
} from './human-contact-tool.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseToolResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>
}

async function invokeTool(
  config: HumanContactToolConfig,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = createHumanContactTool(config)
  const raw = await tool.invoke(input)
  return parseToolResult(raw as string)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HumanContactTool', () => {
  let pendingStore: InMemoryPendingContactStore
  let onPause: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pendingStore = new InMemoryPendingContactStore()
    onPause = vi.fn().mockResolvedValue(undefined)
  })

  // -----------------------------------------------------------------------
  // 1. Approval mode
  // -----------------------------------------------------------------------
  describe('approval mode', () => {
    it('creates a pending contact and returns status pending', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'Deploy to prod?' },
      )

      expect(result['status']).toBe('pending')
      expect(result['channel']).toBe('in-app')
      expect(result['contactId']).toBeDefined()
      expect(typeof result['contactId']).toBe('string')
      expect((result['message'] as string)).toContain('approval')
    })

    it('stores the request with type approval and the provided question', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'Deploy to prod?', context: 'staging passed' },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending).not.toBeNull()
      expect(pending!.request.type).toBe('approval')
      expect((pending!.request.data as Record<string, unknown>)['question']).toBe('Deploy to prod?')
      expect((pending!.request.data as Record<string, unknown>)['context']).toBe('staging passed')
    })

    it('uses default question when none provided', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval' },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect((pending!.request.data as Record<string, unknown>)['question']).toBe('Approve?')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Clarification mode
  // -----------------------------------------------------------------------
  describe('clarification mode', () => {
    it('creates a pending contact with type clarification', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'clarification', question: 'Which database to use?' },
      )

      expect(result['status']).toBe('pending')
      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending).not.toBeNull()
      expect(pending!.request.type).toBe('clarification')
      expect((pending!.request.data as Record<string, unknown>)['question']).toBe('Which database to use?')
    })

    it('uses default question when none provided', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'clarification' },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect((pending!.request.data as Record<string, unknown>)['question']).toBe('Please clarify:')
    })
  })

  // -----------------------------------------------------------------------
  // 3. Input request mode
  // -----------------------------------------------------------------------
  describe('input_request mode', () => {
    it('creates a pending contact with type input_request', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'input_request', question: 'Provide config values', context: 'Need DB creds' },
      )

      expect(result['status']).toBe('pending')
      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending).not.toBeNull()
      expect(pending!.request.type).toBe('input_request')
      expect((pending!.request.data as Record<string, unknown>)['prompt']).toBe('Provide config values')
      expect((pending!.request.data as Record<string, unknown>)['context']).toBe('Need DB creds')
    })

    it('uses default prompt when no question provided', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'input_request' },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect((pending!.request.data as Record<string, unknown>)['prompt']).toBe('Please provide input:')
    })
  })

  // -----------------------------------------------------------------------
  // 4. Escalation mode
  // -----------------------------------------------------------------------
  describe('escalation mode', () => {
    it('creates a pending contact with type escalation', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'escalation', question: 'Cannot resolve merge conflict', context: 'Tried 3 strategies' },
      )

      expect(result['status']).toBe('pending')
      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending).not.toBeNull()
      expect(pending!.request.type).toBe('escalation')
      expect((pending!.request.data as Record<string, unknown>)['summary']).toBe('Cannot resolve merge conflict')
      expect((pending!.request.data as Record<string, unknown>)['reason']).toBe('Tried 3 strategies')
    })

    it('uses default summary and reason when none provided', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'escalation' },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect((pending!.request.data as Record<string, unknown>)['summary']).toBe('Escalated')
      expect((pending!.request.data as Record<string, unknown>)['reason']).toBe('Agent cannot proceed')
    })
  })

  // -----------------------------------------------------------------------
  // 5. Channel resolution
  // -----------------------------------------------------------------------
  describe('channel resolution', () => {
    it('uses explicit channel from tool call input', async () => {
      const result = await invokeTool(
        { pendingStore, onPause, defaultChannel: 'email' },
        { mode: 'approval', question: 'OK?', channel: 'slack' },
      )

      expect(result['channel']).toBe('slack')
      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending!.deliveredTo).toBe('slack')
    })

    it('falls back to agent config default channel when no explicit channel', async () => {
      const result = await invokeTool(
        { pendingStore, onPause, defaultChannel: 'email' },
        { mode: 'approval', question: 'OK?' },
      )

      expect(result['channel']).toBe('email')
    })

    it('falls back to in-app when no channel specified anywhere', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?' },
      )

      expect(result['channel']).toBe('in-app')
    })
  })

  // -----------------------------------------------------------------------
  // 6. Timeout configuration
  // -----------------------------------------------------------------------
  describe('timeout', () => {
    it('sets expiresAt based on timeoutHours', async () => {
      const before = Date.now()
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?', timeoutHours: 2 },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending!.expiresAt).toBeDefined()

      const expiresAt = new Date(pending!.expiresAt!).getTime()
      const expectedMin = before + 2 * 3600 * 1000 - 5000 // 5s tolerance
      const expectedMax = before + 2 * 3600 * 1000 + 5000
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin)
      expect(expiresAt).toBeLessThanOrEqual(expectedMax)
    })

    it('defaults to 24h timeout when timeoutHours not specified', async () => {
      const before = Date.now()
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?' },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending!.expiresAt).toBeDefined()

      const expiresAt = new Date(pending!.expiresAt!).getTime()
      const expectedMin = before + 24 * 3600 * 1000 - 5000
      const expectedMax = before + 24 * 3600 * 1000 + 5000
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin)
      expect(expiresAt).toBeLessThanOrEqual(expectedMax)
    })

    it('stores the fallback value for timeout auto-response', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?', fallback: { approved: false, reason: 'timeout' } },
      )

      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending!.request.timeoutFallback).toEqual({ approved: false, reason: 'timeout' })
    })
  })

  // -----------------------------------------------------------------------
  // 7. Late response / idempotent get
  // -----------------------------------------------------------------------
  describe('InMemoryPendingContactStore', () => {
    it('returns stored contact for subsequent get calls (idempotent read)', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?' },
      )

      const contactId = result['contactId'] as string

      // First get
      const first = await pendingStore.get(contactId)
      expect(first).not.toBeNull()

      // Second get -- same data
      const second = await pendingStore.get(contactId)
      expect(second).toEqual(first)
    })

    it('returns null for unknown contact ids', async () => {
      const result = await pendingStore.get('nonexistent-id')
      expect(result).toBeNull()
    })

    it('delete removes the pending contact', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?' },
      )

      const contactId = result['contactId'] as string
      await pendingStore.delete(contactId)
      const after = await pendingStore.get(contactId)
      expect(after).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // 8. Auto-pause: verify onPause callback
  // -----------------------------------------------------------------------
  describe('auto-pause', () => {
    it('calls onPause with contactId and request when configured', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'Deploy?' },
      )

      expect(onPause).toHaveBeenCalledTimes(1)
      const [calledContactId, calledRequest] = onPause.mock.calls[0] as [string, unknown]
      expect(calledContactId).toBe(result['contactId'])
      expect((calledRequest as Record<string, unknown>)['type']).toBe('approval')
    })

    it('does not throw when onPause is not configured', async () => {
      const result = await invokeTool(
        { pendingStore },
        { mode: 'clarification', question: 'How?' },
      )

      expect(result['status']).toBe('pending')
    })

    it('propagates onPause errors to the tool caller', async () => {
      const failingPause = vi.fn().mockRejectedValue(new Error('pause failed'))

      const tool = createHumanContactTool({ pendingStore, onPause: failingPause })
      await expect(
        tool.invoke({ mode: 'approval', question: 'OK?' }),
      ).rejects.toThrow('pause failed')
    })
  })

  // -----------------------------------------------------------------------
  // Custom / generic mode
  // -----------------------------------------------------------------------
  describe('custom mode', () => {
    it('creates a generic contact request for unknown modes', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'custom_review', data: { reviewType: 'security' } },
      )

      expect(result['status']).toBe('pending')
      const contactId = result['contactId'] as string
      const pending = await pendingStore.get(contactId)
      expect(pending!.request.type).toBe('custom_review')
      expect((pending!.request.data as Record<string, unknown>)['reviewType']).toBe('security')
    })
  })

  // -----------------------------------------------------------------------
  // Tool metadata
  // -----------------------------------------------------------------------
  describe('tool metadata', () => {
    it('has the correct name and description', () => {
      const tool = createHumanContactTool()
      expect(tool.name).toBe('human_contact')
      expect(tool.description).toContain('approval')
      expect(tool.description).toContain('clarification')
    })
  })

  // -----------------------------------------------------------------------
  // Resume URL format
  // -----------------------------------------------------------------------
  describe('response format', () => {
    it('includes resumeWith URL in the response', async () => {
      const result = await invokeTool(
        { pendingStore, onPause },
        { mode: 'approval', question: 'OK?' },
      )

      const contactId = result['contactId'] as string
      expect(result['resumeWith']).toContain(`/human-contact/${contactId}/respond`)
    })
  })
})
