/**
 * Compatibility control-plane support types referenced by the route-family
 * config in `composition/types.ts`: optional mail delivery wiring and the
 * structural lifecycle aliases for the closed-loop prompt/learning processors.
 *
 * Split out of `composition/types.ts` so the structural aliases live beside
 * the mail delivery option type they accompany. Re-exported from
 * `composition/types.ts` to preserve every existing import path; the
 * route-family interface that consumes them stays in `composition/types.ts`.
 */
import type { MailRateLimiterConfig } from "../notifications/mail-rate-limiter.js";
import type { DrizzleStoreDatabase } from "../persistence/drizzle-store-types.js";

/**
 * Optional mail delivery config. When provided, `createForgeApp` constructs a
 * {@link MailRateLimiter}, {@link DrizzleDlqStore}, and {@link DrizzleMailboxStore}
 * wired together, plus starts a {@link MailDlqWorker} that drains the DLQ on
 * a fixed interval. The resulting mailbox store overrides `mailboxStore` on
 * the server config.
 */
export interface MailDeliveryConfig {
  /** Drizzle DB client used by the DLQ store and mailbox store. */
  db: DrizzleStoreDatabase;
  /** Token-bucket configuration. Defaults to 10 tokens / 10-per-minute refill. */
  rateLimiter?: MailRateLimiterConfig;
  /** DLQ drain interval in milliseconds. Defaults to 10s. */
  dlqWorkerIntervalMs?: number;
  /** DLQ batch size per drain. Defaults to 50. */
  dlqBatchSize?: number;
}

/**
 * Structural type matching {@link PromptFeedbackLoop}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 *
 * @deprecated Compatibility alias re-exported via `@dzupagent/server/app` for
 * legacy callers. Inline the `{ start(): void; stop(): void }` shape or
 * import `PromptFeedbackLoop` directly. Not part of the package-root public
 * surface (`@dzupagent/server`).
 */
export interface PromptFeedbackLoopLike {
  start(): void;
  stop(): void;
}

/**
 * Structural type matching {@link LearningEventProcessor}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 *
 * @deprecated Compatibility alias re-exported via `@dzupagent/server/app` for
 * legacy callers. Inline the `{ start(): void; stop(): void }` shape or
 * import `LearningEventProcessor` directly. Not part of the package-root
 * public surface (`@dzupagent/server`).
 */
export interface LearningEventProcessorLike {
  start(): void;
  stop(): void;
}
