/**
 * @forgeagent/core/facades — Namespace re-exports for all curated API facades.
 *
 * @example
 * ```ts
 * import { quickStart, memory, orchestration, security } from '@forgeagent/core/facades';
 *
 * const agent = quickStart.createQuickAgent({ provider: 'anthropic', apiKey: '...' });
 * ```
 */

export * as quickStart from './quick-start.js'
export * as memory from './memory.js'
export * as orchestration from './orchestration.js'
export * as security from './security.js'
