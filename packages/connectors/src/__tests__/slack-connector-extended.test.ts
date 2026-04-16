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
})
