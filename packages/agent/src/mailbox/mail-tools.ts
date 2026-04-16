/**
 * Built-in sendMail and checkMail tools for inter-agent messaging.
 *
 * These are LangChain StructuredTools that wrap an {@link AgentMailbox} instance.
 * The mailbox is injected via the factory config, following the same pattern as
 * {@link createHumanContactTool}.
 *
 * Usage:
 * ```ts
 * const mailbox = new AgentMailboxImpl('agent-1', store, eventBus)
 * const send = createSendMailTool({ mailbox })
 * const check = createCheckMailTool({ mailbox })
 * ```
 */
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { tool } from '@langchain/core/tools'
import type { AgentMailbox } from './types.js'

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

/** Configuration for mailbox tool factories. */
export interface MailToolConfig {
  /** The agent's mailbox instance — all operations are scoped to this mailbox. */
  mailbox: AgentMailbox
}

// ---------------------------------------------------------------------------
// sendMail
// ---------------------------------------------------------------------------

const sendMailInputSchema = z.object({
  to: z
    .string()
    .describe('The recipient agent ID'),
  subject: z
    .string()
    .describe('A short subject line describing the message'),
  body: z
    .record(z.string(), z.unknown())
    .describe('Structured payload to send to the recipient agent'),
})

/**
 * Creates a LangChain-compatible tool that sends a message to another agent
 * via the inter-agent mailbox system.
 *
 * @param config - must include the agent's {@link AgentMailbox} instance
 * @returns a StructuredToolInterface usable with any LangChain agent
 */
export function createSendMailTool(
  config: MailToolConfig,
): StructuredToolInterface {
  const { mailbox } = config

  return tool(
    async (input: z.infer<typeof sendMailInputSchema>): Promise<string> => {
      const message = await mailbox.send(input.to, input.subject, input.body)
      return JSON.stringify({
        messageId: message.id,
        to: message.to,
        subject: message.subject,
      })
    },
    {
      name: 'send_mail',
      description:
        'Send a message to another agent. ' +
        'Use this to communicate tasks, results, or requests to other agents in the system.',
      schema: sendMailInputSchema,
    },
  )
}

// ---------------------------------------------------------------------------
// checkMail
// ---------------------------------------------------------------------------

const checkMailInputSchema = z.object({
  limit: z
    .number()
    .optional()
    .describe('Maximum number of messages to retrieve (default: 10)'),
  unreadOnly: z
    .boolean()
    .optional()
    .describe('If true, only return unread messages (default: true)'),
})

/**
 * Creates a LangChain-compatible tool that checks the agent's mailbox
 * for incoming messages from other agents.
 *
 * @param config - must include the agent's {@link AgentMailbox} instance
 * @returns a StructuredToolInterface usable with any LangChain agent
 */
export function createCheckMailTool(
  config: MailToolConfig,
): StructuredToolInterface {
  const { mailbox } = config

  return tool(
    async (input: z.infer<typeof checkMailInputSchema>): Promise<string> => {
      const messages = await mailbox.receive({
        limit: input.limit,
        unreadOnly: input.unreadOnly,
      })

      const cleaned = messages.map((msg) => ({
        id: msg.id,
        from: msg.from,
        subject: msg.subject,
        body: msg.body,
        createdAt: msg.createdAt,
      }))

      return JSON.stringify(cleaned)
    },
    {
      name: 'check_mail',
      description:
        'Check this agent\'s mailbox for messages from other agents. ' +
        'Returns a list of messages with sender, subject, and body.',
      schema: checkMailInputSchema,
    },
  )
}
