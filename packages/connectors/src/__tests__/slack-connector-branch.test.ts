/**
 * Branch-coverage tests for the Slack connector.
 *
 * Targets branches not exercised elsewhere:
 *  - slack_list_channels with missing `channels` key
 *  - slack_search_messages with missing matches / unknown channel names
 *  - slack_send_message with thread_ts
 *  - fallback "unknown" error text when API omits `error`
 *  - toolkit wrapper and tool filtering
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSlackConnector,
  createSlackConnectorToolkit,
} from '../slack/slack-connector.js'

describe('Slack connector — branch coverage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockSlackApi(response: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // -------------------------------------------------------------------------
  // list_channels branches
  // -------------------------------------------------------------------------

  describe('slack_list_channels', () => {
    it('returns empty output when channels key is missing', async () => {
      mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toBe('')
    })

    it('formats list with #name and id', async () => {
      mockSlackApi({
        ok: true,
        channels: [
          { name: 'general', id: 'C1' },
          { name: 'random', id: 'C2' },
        ],
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toContain('#general (C1)')
      expect(result).toContain('#random (C2)')
    })

    it('uses default limit of 20', async () => {
      const mock = mockSlackApi({ ok: true, channels: [] })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      await listTool.invoke({})
      const body = JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string)
      expect(body.limit).toBe(20)
    })

    it('uses explicit limit when provided', async () => {
      const mock = mockSlackApi({ ok: true, channels: [] })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      await listTool.invoke({ limit: 100 })
      const body = JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string)
      expect(body.limit).toBe(100)
    })

    it('returns "unknown" error when API omits error field', async () => {
      mockSlackApi({ ok: false })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toBe('Error: unknown')
    })

    it('returns specific error when API provides one', async () => {
      mockSlackApi({ ok: false, error: 'missing_scope' })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const listTool = tools.find(t => t.name === 'slack_list_channels')!
      const result = await listTool.invoke({})
      expect(result).toBe('Error: missing_scope')
    })
  })

  // -------------------------------------------------------------------------
  // search_messages branches
  // -------------------------------------------------------------------------

  describe('slack_search_messages', () => {
    it('returns empty output when messages key is missing', async () => {
      mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'hello' })
      expect(result).toBe('')
    })

    it('returns empty output when matches array is missing', async () => {
      mockSlackApi({ ok: true, messages: {} })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'hello' })
      expect(result).toBe('')
    })

    it('uses "?" placeholder when channel.name is missing', async () => {
      mockSlackApi({
        ok: true,
        messages: {
          matches: [
            { text: 'hello world' },
            { text: 'second', channel: { name: 'general' } },
            { text: 'third', channel: {} },
          ],
        },
      })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'hello' })
      expect(result).toContain('[?] hello world')
      expect(result).toContain('[general] second')
      expect(result).toContain('[?] third')
    })

    it('uses default count of 10', async () => {
      const mock = mockSlackApi({ ok: true, messages: { matches: [] } })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      await searchTool.invoke({ query: 'foo' })
      const body = JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string)
      expect(body.count).toBe(10)
    })

    it('uses explicit count when provided', async () => {
      const mock = mockSlackApi({ ok: true, messages: { matches: [] } })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      await searchTool.invoke({ query: 'foo', count: 25 })
      const body = JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string)
      expect(body.count).toBe(25)
    })

    it('returns "unknown" error when API omits error field', async () => {
      mockSlackApi({ ok: false })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const searchTool = tools.find(t => t.name === 'slack_search_messages')!
      const result = await searchTool.invoke({ query: 'foo' })
      expect(result).toBe('Error: unknown')
    })
  })

  // -------------------------------------------------------------------------
  // send_message branches
  // -------------------------------------------------------------------------

  describe('slack_send_message', () => {
    it('passes thread_ts through to the API when supplied', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({
        channel: '#general',
        text: 'hi',
        thread_ts: '1234.5678',
      })
      const body = JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string)
      expect(body.thread_ts).toBe('1234.5678')
    })

    it('omits thread_ts when not provided (value is undefined)', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'hi' })
      const bodyText = (mock.mock.calls[0]?.[1] as RequestInit).body as string
      const body = JSON.parse(bodyText)
      expect(body.thread_ts).toBeUndefined()
    })

    it('sends Authorization header with Bearer token', async () => {
      const mock = mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-real' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      await sendTool.invoke({ channel: '#general', text: 'hi' })
      const init = mock.mock.calls[0]?.[1] as RequestInit
      const headers = init.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer xoxb-real')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('returns "unknown" error when API omits error field', async () => {
      mockSlackApi({ ok: false })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#foo', text: 'x' })
      expect(result).toBe('Error: unknown')
    })

    it('returns success message on ok=true', async () => {
      mockSlackApi({ ok: true })
      const tools = createSlackConnector({ token: 'xoxb-test' })
      const sendTool = tools.find(t => t.name === 'slack_send_message')!
      const result = await sendTool.invoke({ channel: '#general', text: 'hi' })
      expect(result).toContain('Message sent to #general')
    })
  })

  // -------------------------------------------------------------------------
  // Toolkit + tool filtering
  // -------------------------------------------------------------------------

  describe('createSlackConnectorToolkit', () => {
    it('returns toolkit with name "slack"', () => {
      const kit = createSlackConnectorToolkit({ token: 'x' })
      expect(kit.name).toBe('slack')
      expect(kit.tools.length).toBe(3)
    })

    it('propagates enabledTools filter', () => {
      const kit = createSlackConnectorToolkit({
        token: 'x',
        enabledTools: ['slack_send_message'],
      })
      expect(kit.tools).toHaveLength(1)
      expect(kit.tools[0]!.name).toBe('slack_send_message')
      expect(kit.enabledTools).toEqual(['slack_send_message'])
    })

    it('returns empty when enabledTools matches nothing', () => {
      const kit = createSlackConnectorToolkit({
        token: 'x',
        enabledTools: ['nope'],
      })
      expect(kit.tools).toHaveLength(0)
    })
  })
})
