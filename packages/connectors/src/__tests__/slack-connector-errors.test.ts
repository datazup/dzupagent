/**
 * Slack connector error handling tests — covers fetch failures,
 * HTTP non-200 responses, missing fields, and edge cases in
 * response parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSlackConnector } from '../slack/slack-connector.js'

describe('Slack connector — error edge cases', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockSlackApi(response: Record<string, unknown> = { ok: true }) {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // ── Network errors ────────────────────────────────────

  describe('network error handling', () => {
    it('slack_send_message propagates fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!

      await expect(sendTool.invoke({ channel: '#general', text: 'Hi' }))
        .rejects.toThrow('fetch failed')
    })

    it('slack_list_channels propagates fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!

      await expect(listTool.invoke({})).rejects.toThrow('network down')
    })

    it('slack_search_messages propagates fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!

      await expect(searchTool.invoke({ query: 'test' })).rejects.toThrow('timeout')
    })
  })

  // ── Slack API specific error codes ────────────────────

  describe('Slack API error codes', () => {
    it('handles token_revoked error', async () => {
      mockSlackApi({ ok: false, error: 'token_revoked' })
      const tools = createSlackConnector({ token: 'xoxb-revoked' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'Hi' })

      expect(result).toContain('Error')
      expect(result).toContain('token_revoked')
    })

    it('handles too_many_attachments error', async () => {
      mockSlackApi({ ok: false, error: 'too_many_attachments' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'Hi' })

      expect(result).toContain('too_many_attachments')
    })

    it('handles rate_limited error on list channels', async () => {
      mockSlackApi({ ok: false, error: 'ratelimited' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})

      expect(result).toContain('Error')
      expect(result).toContain('ratelimited')
    })

    it('handles missing_scope error on search', async () => {
      mockSlackApi({ ok: false, error: 'missing_scope' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'test' })

      expect(result).toContain('missing_scope')
    })
  })

  // ── Message formatting edge cases ─────────────────────

  describe('message edge cases', () => {
    it('handles empty text in send_message', async () => {
      mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: '' })

      expect(result).toContain('Message sent')
    })

    it('handles mentions in text', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: '<@U1234> please review' })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['text']).toContain('<@U1234>')
    })

    it('handles channel mentions in text', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'cc <!channel>' })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['text']).toContain('<!channel>')
    })
  })

  // ── Search results edge cases ─────────────────────────

  describe('search results edge cases', () => {
    it('handles messages with missing text field', async () => {
      mockSlackApi({
        ok: true,
        messages: {
          matches: [
            { channel: { name: 'general' } },
          ],
        },
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'test' })

      expect(result).toContain('[general]')
    })

    it('handles null messages field', async () => {
      mockSlackApi({ ok: true, messages: null })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'test' })

      // Should not crash — messages?.matches ?? [] handles null
      expect(result).toBe('')
    })
  })

  // ── Channel listing edge cases ────────────────────────

  describe('channel listing edge cases', () => {
    it('handles channels with special characters in name', async () => {
      mockSlackApi({
        ok: true,
        channels: [
          { name: 'team-alpha_2026', id: 'C999' },
        ],
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})

      expect(result).toContain('#team-alpha_2026 (C999)')
    })

    it('handles channels missing id field', async () => {
      mockSlackApi({
        ok: true,
        channels: [
          { name: 'orphan' },
        ],
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})

      expect(result).toContain('#orphan')
    })
  })
})
