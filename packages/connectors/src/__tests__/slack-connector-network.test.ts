/**
 * Slack connector network error tests — covers fetch failures, non-JSON
 * responses, and edge cases in tool invocations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSlackConnector } from '../slack/slack-connector.js'

describe('Slack connector — network and edge cases', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockSlackApi(response: Record<string, unknown> = { ok: true }): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  function tool(name: string) {
    const tools = createSlackConnector({ token: 'xoxb-test' })
    return tools.find(t => t.name === name)!
  }

  // ── Network errors ────────────────────────────────────

  describe('fetch failures', () => {
    it('propagates network error in slack_send_message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')))
      await expect(tool('slack_send_message').invoke({ channel: '#general', text: 'hi' }))
        .rejects.toThrow('network error')
    })

    it('propagates network error in slack_list_channels', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')))
      await expect(tool('slack_list_channels').invoke({}))
        .rejects.toThrow('connection refused')
    })

    it('propagates network error in slack_search_messages', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('DNS failure')))
      await expect(tool('slack_search_messages').invoke({ query: 'test' }))
        .rejects.toThrow('DNS failure')
    })
  })

  // ── Message sending edge cases ────────────────────────

  describe('slack_send_message — additional cases', () => {
    it('handles very long message text', async () => {
      mockSlackApi({ ok: true })
      const longText = 'a'.repeat(4000)
      const result = await tool('slack_send_message').invoke({ channel: '#general', text: longText })
      expect(result).toContain('Message sent to #general')
    })

    it('handles special characters in channel name', async () => {
      mockSlackApi({ ok: true })
      const result = await tool('slack_send_message').invoke({ channel: '#dev-ops_alerts', text: 'hi' })
      expect(result).toContain('Message sent to #dev-ops_alerts')
    })
  })

  // ── Channel listing edge cases ────────────────────────

  describe('slack_list_channels — additional cases', () => {
    it('handles channels with special characters in names', async () => {
      mockSlackApi({
        ok: true,
        channels: [
          { name: 'dev-ops_alerts', id: 'C100' },
        ],
      })
      const result = await tool('slack_list_channels').invoke({})
      expect(result).toContain('#dev-ops_alerts (C100)')
    })

    it('handles large channel list', async () => {
      const channels = Array.from({ length: 50 }, (_, i) => ({
        name: `channel-${i}`,
        id: `C${String(i).padStart(6, '0')}`,
      }))
      mockSlackApi({ ok: true, channels })
      const result = await tool('slack_list_channels').invoke({})
      expect(result.split('\n')).toHaveLength(50)
    })
  })

  // ── Search edge cases ─────────────────────────────────

  describe('slack_search_messages — additional cases', () => {
    it('handles messages with missing text field', async () => {
      mockSlackApi({
        ok: true,
        messages: {
          matches: [
            { channel: { name: 'general' } },
          ],
        },
      })
      const result = await tool('slack_search_messages').invoke({ query: 'test' })
      expect(result).toContain('[general]')
    })

    it('handles deeply nested channel objects', async () => {
      mockSlackApi({
        ok: true,
        messages: {
          matches: [
            { text: 'found', channel: { name: 'eng', id: 'C1' } },
          ],
        },
      })
      const result = await tool('slack_search_messages').invoke({ query: 'test' })
      expect(result).toContain('[eng] found')
    })
  })

  // ── All tools returned by default ─────────────────────

  describe('tool list', () => {
    it('returns exactly 3 tools by default', () => {
      const tools = createSlackConnector({ token: 'xoxb-test' })
      expect(tools).toHaveLength(3)
      const names = tools.map(t => t.name)
      expect(names).toContain('slack_send_message')
      expect(names).toContain('slack_list_channels')
      expect(names).toContain('slack_search_messages')
    })
  })
})
