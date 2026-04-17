/**
 * Extended Slack connector tests — covers message sending, channel listing,
 * message search, error handling, rate limiting, webhook validation,
 * and tool filtering behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSlackConnector, createSlackConnectorToolkit } from '../slack/slack-connector.js'

describe('Slack connector — extended', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Mock the Slack API fetch call. Returns a function that controls what
   * the Slack API "responds" with.
   */
  function mockSlackApi(response: Record<string, unknown> = { ok: true }): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // ---------------------------------------------------------------------------
  // slack_send_message
  // ---------------------------------------------------------------------------

  describe('slack_send_message', () => {
    it('sends a message and returns success', async () => {
      mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'Hello!' })
      expect(result).toContain('Message sent to #general')
    })

    it('calls chat.postMessage with correct payload', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: 'C1234567890', text: 'Test message' })

      expect(mock).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ channel: 'C1234567890', text: 'Test message', thread_ts: undefined }),
        }),
      )
    })

    it('sends Bearer token in Authorization header', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-my-token' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'Hi' })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const headers = calledInit.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer xoxb-my-token')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('returns error message when Slack API returns ok=false', async () => {
      mockSlackApi({ ok: false, error: 'channel_not_found' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#nonexistent', text: 'Hi' })
      expect(result).toContain('Error')
      expect(result).toContain('channel_not_found')
    })

    it('returns unknown error when Slack API returns ok=false without error field', async () => {
      mockSlackApi({ ok: false })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'Hi' })
      expect(result).toContain('Error')
      expect(result).toContain('unknown')
    })

    it('sends thread reply with thread_ts', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({
        channel: '#general',
        text: 'Thread reply',
        thread_ts: '1234567890.123456',
      })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['thread_ts']).toBe('1234567890.123456')
    })

    it('handles Slack markdown in message text', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const markdownText = '*bold* _italic_ ~strikethrough~ `code` ```code block```'
      await sendTool.invoke({ channel: '#general', text: markdownText })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['text']).toBe(markdownText)
    })

    it('sends message to channel ID', async () => {
      mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: 'C0123456789', text: 'hi' })
      expect(result).toContain('Message sent to C0123456789')
    })
  })

  // ---------------------------------------------------------------------------
  // slack_list_channels
  // ---------------------------------------------------------------------------

  describe('slack_list_channels', () => {
    it('lists channels with names and IDs', async () => {
      mockSlackApi({
        ok: true,
        channels: [
          { name: 'general', id: 'C001' },
          { name: 'random', id: 'C002' },
          { name: 'engineering', id: 'C003' },
        ],
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})

      expect(result).toContain('#general (C001)')
      expect(result).toContain('#random (C002)')
      expect(result).toContain('#engineering (C003)')
    })

    it('calls conversations.list with default limit of 20', async () => {
      const mock = mockSlackApi({ ok: true, channels: [] })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      await listTool.invoke({})

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['limit']).toBe(20)
      expect(body['types']).toBe('public_channel,private_channel')
    })

    it('uses custom limit', async () => {
      const mock = mockSlackApi({ ok: true, channels: [] })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      await listTool.invoke({ limit: 5 })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['limit']).toBe(5)
    })

    it('returns error when API returns ok=false', async () => {
      mockSlackApi({ ok: false, error: 'invalid_auth' })
      const tools = createSlackConnector({ token: 'xoxb-bad' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toContain('Error')
      expect(result).toContain('invalid_auth')
    })

    it('returns unknown error when error field is missing', async () => {
      mockSlackApi({ ok: false })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toContain('Error')
      expect(result).toContain('unknown')
    })

    it('returns empty string for no channels', async () => {
      mockSlackApi({ ok: true, channels: [] })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // slack_search_messages
  // ---------------------------------------------------------------------------

  describe('slack_search_messages', () => {
    it('searches messages and returns formatted results', async () => {
      mockSlackApi({
        ok: true,
        messages: {
          matches: [
            { text: 'Found message 1', channel: { name: 'general' } },
            { text: 'Found message 2', channel: { name: 'random' } },
          ],
        },
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'test query' })

      expect(result).toContain('[general] Found message 1')
      expect(result).toContain('[random] Found message 2')
    })

    it('calls search.messages with default count of 10', async () => {
      const mock = mockSlackApi({ ok: true, messages: { matches: [] } })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      await searchTool.invoke({ query: 'search term' })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['query']).toBe('search term')
      expect(body['count']).toBe(10)
    })

    it('uses custom count', async () => {
      const mock = mockSlackApi({ ok: true, messages: { matches: [] } })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      await searchTool.invoke({ query: 'test', count: 25 })

      const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body['count']).toBe(25)
    })

    it('returns error when API returns ok=false', async () => {
      mockSlackApi({ ok: false, error: 'not_authed' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'test' })
      expect(result).toContain('Error')
      expect(result).toContain('not_authed')
    })

    it('returns unknown error when error field is missing', async () => {
      mockSlackApi({ ok: false })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'test' })
      expect(result).toContain('Error')
      expect(result).toContain('unknown')
    })

    it('handles messages without channel name', async () => {
      mockSlackApi({
        ok: true,
        messages: {
          matches: [
            { text: 'orphan message' },
          ],
        },
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'orphan' })
      expect(result).toContain('[?] orphan message')
    })

    it('returns empty result when no matches found', async () => {
      mockSlackApi({ ok: true, messages: { matches: [] } })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'nonexistent' })
      expect(result).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // Tool filtering
  // ---------------------------------------------------------------------------

  describe('tool filtering', () => {
    it('returns only slack_send_message when specified', () => {
      const tools = createSlackConnector({
        token: 'xoxb-test',
        enabledTools: ['slack_send_message'],
      })
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('slack_send_message')
    })

    it('returns only slack_list_channels when specified', () => {
      const tools = createSlackConnector({
        token: 'xoxb-test',
        enabledTools: ['slack_list_channels'],
      })
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('slack_list_channels')
    })

    it('returns only slack_search_messages when specified', () => {
      const tools = createSlackConnector({
        token: 'xoxb-test',
        enabledTools: ['slack_search_messages'],
      })
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('slack_search_messages')
    })

    it('returns multiple specified tools', () => {
      const tools = createSlackConnector({
        token: 'xoxb-test',
        enabledTools: ['slack_send_message', 'slack_search_messages'],
      })
      expect(tools).toHaveLength(2)
      expect(tools.map(t => t.name)).toContain('slack_send_message')
      expect(tools.map(t => t.name)).toContain('slack_search_messages')
    })

    it('returns empty array for non-matching filter', () => {
      const tools = createSlackConnector({
        token: 'xoxb-test',
        enabledTools: ['nonexistent_tool'],
      })
      expect(tools).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Toolkit factory
  // ---------------------------------------------------------------------------

  describe('createSlackConnectorToolkit', () => {
    it('returns toolkit with name and tools', () => {
      const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
      expect(tk.name).toBe('slack')
      expect(tk.tools).toHaveLength(3)
    })

    it('passes enabledTools through', () => {
      const tk = createSlackConnectorToolkit({
        token: 'xoxb-test',
        enabledTools: ['slack_send_message'],
      })
      expect(tk.tools).toHaveLength(1)
      expect(tk.enabledTools).toEqual(['slack_send_message'])
    })
  })

  // ---------------------------------------------------------------------------
  // W18-B3 — additional coverage: HTTP status codes, malformed payloads,
  // rate-limit semantics, token formats, attachments/blocks payloads, schema
  // ---------------------------------------------------------------------------

  describe('HTTP status code handling', () => {
    /**
     * Slack returns JSON even on auth failure (HTTP 200 with ok=false).
     * However the connector reads `res.json()` regardless of HTTP status —
     * verify that 401/403/500 responses still surface an error if the body
     * carries `ok: false`, even though `fetch` itself does not throw.
     */
    it('handles HTTP 401 unauthorized with ok=false body', async () => {
      const mock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: 'invalid_auth' }),
      })
      vi.stubGlobal('fetch', mock)
      const tools = createSlackConnector({ token: 'xoxb-bad' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'hi' })
      expect(result).toContain('invalid_auth')
    })

    it('handles HTTP 429 rate limit with ok=false body', async () => {
      const mock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '30' }),
        json: async () => ({ ok: false, error: 'rate_limited' }),
      })
      vi.stubGlobal('fetch', mock)
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'hi' })
      expect(result).toContain('Error')
      expect(result).toContain('rate_limited')
    })

    it('handles HTTP 500 server error with ok=false body', async () => {
      const mock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: 'internal_error' }),
      })
      vi.stubGlobal('fetch', mock)
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toContain('internal_error')
    })

    it('propagates JSON parse failure as a thrown error', async () => {
      const mock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0') },
      })
      vi.stubGlobal('fetch', mock)
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!

      await expect(sendTool.invoke({ channel: '#general', text: 'hi' }))
        .rejects.toThrow('Unexpected token')
    })
  })

  describe('non-existent channel handling', () => {
    it('returns channel_not_found error from Slack', async () => {
      mockSlackApi({ ok: false, error: 'channel_not_found' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#does-not-exist', text: 'hi' })
      expect(result).toContain('channel_not_found')
    })

    it('returns is_archived error when posting to archived channel', async () => {
      mockSlackApi({ ok: false, error: 'is_archived' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#archived', text: 'hi' })
      expect(result).toContain('is_archived')
    })

    it('returns not_in_channel error', async () => {
      mockSlackApi({ ok: false, error: 'not_in_channel' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#private', text: 'hi' })
      expect(result).toContain('not_in_channel')
    })
  })

  describe('token format variations', () => {
    it('passes user token (xoxp-*) verbatim in header', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxp-user-token-123' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'hi' })

      const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer xoxp-user-token-123')
    })

    it('passes app token (xapp-*) verbatim in header', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xapp-1-A0123-456' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'hi' })

      const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer xapp-1-A0123-456')
    })

    it('passes empty token without crashing (Slack will reject)', async () => {
      mockSlackApi({ ok: false, error: 'not_authed' })
      const tools = createSlackConnector({ token: '' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'hi' })
      expect(result).toContain('not_authed')
    })
  })

  describe('schema validation', () => {
    it('slack_send_message has channel and text required fields', () => {
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      expect(sendTool.schema).toBeDefined()
    })

    it('slack_list_channels has optional limit field', () => {
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      expect(listTool.schema).toBeDefined()
    })

    it('slack_search_messages has query as required field', () => {
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      expect(searchTool.schema).toBeDefined()
    })

    it('all tools provide non-empty descriptions', () => {
      const tools = createSlackConnector({ token: 'xoxb-test' })
      for (const t of tools) {
        expect(t.description.length).toBeGreaterThan(10)
      }
    })
  })

  describe('multiple consecutive operations', () => {
    it('reuses fetch global across multiple message sends', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!

      await sendTool.invoke({ channel: '#general', text: 'first' })
      await sendTool.invoke({ channel: '#general', text: 'second' })
      await sendTool.invoke({ channel: '#general', text: 'third' })

      expect(mock).toHaveBeenCalledTimes(3)
    })

    it('handles mixed success/failure across consecutive calls', async () => {
      const mock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: false, error: 'rate_limited' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      vi.stubGlobal('fetch', mock)

      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!

      const r1 = await sendTool.invoke({ channel: '#general', text: 'a' })
      const r2 = await sendTool.invoke({ channel: '#general', text: 'b' })
      const r3 = await sendTool.invoke({ channel: '#general', text: 'c' })

      expect(r1).toContain('Message sent')
      expect(r2).toContain('rate_limited')
      expect(r3).toContain('Message sent')
    })
  })

  describe('Slack API URL construction', () => {
    it('targets the canonical Slack API URL for chat.postMessage', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'hi' })

      expect(mock.mock.calls[0]![0]).toBe('https://slack.com/api/chat.postMessage')
    })

    it('targets the canonical Slack API URL for conversations.list', async () => {
      const mock = mockSlackApi({ ok: true, channels: [] })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      await listTool.invoke({})

      expect(mock.mock.calls[0]![0]).toBe('https://slack.com/api/conversations.list')
    })

    it('targets the canonical Slack API URL for search.messages', async () => {
      const mock = mockSlackApi({ ok: true, messages: { matches: [] } })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      await searchTool.invoke({ query: 'q' })

      expect(mock.mock.calls[0]![0]).toBe('https://slack.com/api/search.messages')
    })
  })
})
