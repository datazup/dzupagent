export type {
  MailMessage,
  MailboxQuery,
  MailboxStore,
  AgentMailbox,
} from './types.js'

export { InMemoryMailboxStore } from './in-memory-mailbox-store.js'
export { AgentMailboxImpl } from './agent-mailbox.js'
export type { AgentMailboxOptions } from './agent-mailbox.js'

export { createSendMailTool, createCheckMailTool } from './mail-tools.js'
export type { MailToolConfig } from './mail-tools.js'

// Dead-letter queue
export {
  InMemoryDeadLetterStore,
} from './dead-letter-store.js'
export type {
  DeadLetter,
  DeadLetterMeta,
  DeadLetterStore,
} from './dead-letter-store.js'

// Rate limiter
export {
  RateLimiter,
  MailRateLimitedError,
  DEFAULT_RATE_LIMIT,
} from './rate-limiter.js'
export type { RateLimiterConfig } from './rate-limiter.js'
