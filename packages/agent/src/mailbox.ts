/**
 * @dzupagent/agent/mailbox — mailbox store, dead-letter queue, and mail tools.
 *
 * Re-exports the mailbox subsystem for hosts that persist or route inter-agent
 * messages. Use this subpath when implementing a custom MailboxStore backend or
 * wiring the in-memory store into a server.
 */

export * from './mailbox/index.js'
