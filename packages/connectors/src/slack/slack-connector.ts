/**
 * Slack connector — tools for sending messages and interacting with Slack.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { filterTools } from '../connector-types.js'

export interface SlackConnectorConfig {
  token: string
  enabledTools?: string[]
}

const SLACK_API = 'https://slack.com/api'

export function createSlackConnector(config: SlackConnectorConfig): DynamicStructuredTool[] {
  async function slack(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return res.json()
  }

  const all: DynamicStructuredTool[] = [
    new DynamicStructuredTool({
      name: 'slack_send_message',
      description: 'Send a message to a Slack channel',
      schema: z.object({
        channel: z.string().describe('Channel ID or name (e.g., #general or C1234567890)'),
        text: z.string().describe('Message text (supports Slack markdown)'),
        thread_ts: z.string().optional().describe('Thread timestamp for replies'),
      }),
      func: async ({ channel, text, thread_ts }) => {
        const data = await slack('chat.postMessage', { channel, text, thread_ts }) as Record<string, unknown>
        return data['ok'] ? `Message sent to ${channel}` : `Error: ${data['error'] ?? 'unknown'}`
      },
    }),

    new DynamicStructuredTool({
      name: 'slack_list_channels',
      description: 'List Slack channels the bot has access to',
      schema: z.object({
        limit: z.number().optional().describe('Max channels to return (default: 20)'),
      }),
      func: async ({ limit }) => {
        const data = await slack('conversations.list', { limit: limit ?? 20, types: 'public_channel,private_channel' }) as Record<string, unknown>
        if (!data['ok']) return `Error: ${data['error'] ?? 'unknown'}`
        const channels = (data['channels'] ?? []) as Array<Record<string, unknown>>
        return channels.map(c => `#${c['name']} (${c['id']})`).join('\n')
      },
    }),

    new DynamicStructuredTool({
      name: 'slack_search_messages',
      description: 'Search messages across Slack channels',
      schema: z.object({
        query: z.string().describe('Search query'),
        count: z.number().optional().describe('Max results (default: 10)'),
      }),
      func: async ({ query, count }) => {
        const data = await slack('search.messages', { query, count: count ?? 10 }) as Record<string, unknown>
        if (!data['ok']) return `Error: ${data['error'] ?? 'unknown'}`
        const messages = (data['messages'] as Record<string, unknown>)?.['matches'] as Array<Record<string, unknown>> ?? []
        return messages.map(m => `[${m['channel']?.['name'] ?? '?'}] ${m['text']}`).join('\n\n')
      },
    }),
  ]

  return filterTools(all, config.enabledTools)
}
