/**
 * Unit tests for sendMail and checkMail LangChain tools.
 *
 * Covers: correct argument forwarding, return shapes, field filtering,
 * default parameters, and schema validation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSendMailTool, createCheckMailTool } from '../mail-tools.js'
import type { AgentMailbox, MailMessage, MailboxQuery } from '../types.js'

function createMockMailbox(): AgentMailbox {
  return {
    agentId: 'agent-a',
    send: vi.fn<[string, string, Record<string, unknown>], Promise<MailMessage>>(
      async (to, subject, body) => ({
        id: 'generated-id',
        from: 'agent-a',
        to,
        subject,
        body,
        createdAt: 1700000000000,
      }),
    ),
    receive: vi.fn<[MailboxQuery?], Promise<MailMessage[]>>(async () => [
      {
        id: 'msg-1',
        from: 'agent-b',
        to: 'agent-a',
        subject: 'Update',
        body: { status: 'done' },
        createdAt: 1700000000000,
        readAt: undefined,
        ttl: 3600,
      },
    ]),
    subscribe: vi.fn(() => () => {}),
    ack: vi.fn(async () => {}),
  }
}

describe('createSendMailTool', () => {
  let mailbox: ReturnType<typeof createMockMailbox>

  beforeEach(() => {
    mailbox = createMockMailbox()
  })

  it('calls mailbox.send() with correct args', async () => {
    const sendTool = createSendMailTool({ mailbox })

    await sendTool.invoke({
      to: 'agent-b',
      subject: 'Task Complete',
      body: { result: 42 },
    })

    expect(mailbox.send).toHaveBeenCalledWith(
      'agent-b',
      'Task Complete',
      { result: 42 },
    )
  })

  it('returns JSON with messageId, to, and subject', async () => {
    const sendTool = createSendMailTool({ mailbox })

    const rawResult = await sendTool.invoke({
      to: 'agent-b',
      subject: 'Report',
      body: { data: 'attached' },
    })

    const result = JSON.parse(rawResult as string)
    expect(result).toEqual({
      messageId: 'generated-id',
      to: 'agent-b',
      subject: 'Report',
    })
  })

  it('has the correct tool name and description', () => {
    const sendTool = createSendMailTool({ mailbox })
    expect(sendTool.name).toBe('send_mail')
    expect(sendTool.description).toContain('Send a message')
  })
})

describe('createCheckMailTool', () => {
  let mailbox: ReturnType<typeof createMockMailbox>

  beforeEach(() => {
    mailbox = createMockMailbox()
  })

  it('calls mailbox.receive() with correct query', async () => {
    const checkTool = createCheckMailTool({ mailbox })

    await checkTool.invoke({ limit: 5, unreadOnly: false })

    expect(mailbox.receive).toHaveBeenCalledWith({
      limit: 5,
      unreadOnly: false,
    })
  })

  it('returns array without readAt or ttl fields', async () => {
    const checkTool = createCheckMailTool({ mailbox })

    const rawResult = await checkTool.invoke({})

    const result = JSON.parse(rawResult as string)
    expect(result).toHaveLength(1)

    const msg = result[0]
    expect(msg).toHaveProperty('id')
    expect(msg).toHaveProperty('from')
    expect(msg).toHaveProperty('subject')
    expect(msg).toHaveProperty('body')
    expect(msg).toHaveProperty('createdAt')
    // These internal fields should be stripped
    expect(msg).not.toHaveProperty('readAt')
    expect(msg).not.toHaveProperty('ttl')
  })

  it('passes default limit and unreadOnly when not specified', async () => {
    const checkTool = createCheckMailTool({ mailbox })

    await checkTool.invoke({})

    // When no input provided, receive is called with { limit: undefined, unreadOnly: undefined }
    // which lets the store apply its own defaults
    expect(mailbox.receive).toHaveBeenCalledWith({
      limit: undefined,
      unreadOnly: undefined,
    })
  })

  it('has the correct tool name and description', () => {
    const checkTool = createCheckMailTool({ mailbox })
    expect(checkTool.name).toBe('check_mail')
    expect(checkTool.description).toContain('Check')
    expect(checkTool.description).toContain('mailbox')
  })

  it('rejects invalid input types via schema', async () => {
    const checkTool = createCheckMailTool({ mailbox })

    // limit should be a number, passing string should fail
    await expect(
      checkTool.invoke({ limit: 'not-a-number' } as unknown),
    ).rejects.toThrow()
  })
})
