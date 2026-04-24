/**
 * @dzupagent/core/facades — Namespace re-exports for all curated API facades.
 *
 * NOTE: The `memory` facade was removed as part of MC-A01 (layer-inversion fix).
 * Consumers should import directly from `@dzupagent/memory`.
 *
 * @example
 * ```ts
 * import { quickStart, orchestration, security } from '@dzupagent/core/facades';
 *
 * const agent = quickStart.createQuickAgent({ provider: 'anthropic', apiKey: '...' });
 * ```
 */

export * as quickStart from './quick-start.js'
export * as orchestration from './orchestration.js'
export * as security from './security.js'
