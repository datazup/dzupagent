import { describe, it } from 'vitest'

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held 72 `it()` blocks (1464 lines) under `@ts-nocheck`.
 * Six classes — `NotificationDeduplicator`, `PriorityChannelDispatcher`,
 * `EmailChannel`, `SlackChannel`, `WebhookChannel`, `ReceiptStore` — were all
 * DEFINED LOCALLY at lines 123-400. Only one `new ApprovalGate` existed in the
 * whole file (line 1365, a single integration describe); the other ~65 tests
 * exercised the local copies.
 *
 * UNTESTED PRODUCTION SYMBOLS:
 *   - `SlackNotificationChannel`       — packages/server/src/notifications/channels/
 *   - `EmailWebhookNotificationChannel` — packages/server/src/notifications/channels/
 * Neither was imported here, so retry/backoff/dedup behaviour of the shipped
 * channels is genuinely uncovered. `@ts-nocheck` also meant TypeScript could
 * not flag the local classes drifting from the contracts they claimed to mirror.
 *
 * Removed 2026-07-27.
 */
describe.skip('notification channels (production channels in @dzupagent/server untested)', () => {
  it('needs tests against SlackNotificationChannel / EmailWebhookNotificationChannel', () => {})
})
