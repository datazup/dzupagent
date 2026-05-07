/**
 * @dzupagent/core/plugins — Plugin registry, manifest, discovery, plus DI
 * container, configuration, and i18n primitives.
 *
 * @example
 * ```ts
 * import {
 *   PluginRegistry,
 *   createContainer,
 *   resolveConfig,
 * } from '@dzupagent/core/plugins'
 * ```
 */

// ---------------------------------------------------------------------------
// DI Container
// ---------------------------------------------------------------------------
export { ForgeContainer, createContainer } from './config/container.js'

// ---------------------------------------------------------------------------
// Plugin types and registry
// ---------------------------------------------------------------------------
export type { DzupPlugin, PluginContext } from './plugin/plugin-types.js'
export { PluginRegistry } from './plugin/plugin-registry.js'

// ---------------------------------------------------------------------------
// Plugin discovery and manifests
// ---------------------------------------------------------------------------
export {
  discoverPlugins,
  validateManifest,
  resolvePluginOrder,
} from './plugin/plugin-discovery.js'
export type {
  PluginManifest,
  DiscoveredPlugin,
  PluginDiscoveryConfig,
} from './plugin/plugin-discovery.js'
export { createManifest, serializeManifest } from './plugin/plugin-manifest.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export {
  DEFAULT_CONFIG,
  loadEnvConfig,
  loadFileConfig,
  mergeConfigs,
  resolveConfig,
  validateConfig,
  getConfigValue,
} from './config/index.js'
export type {
  ForgeConfig,
  ProviderConfig,
  RateLimitConfig,
  ConfigLayer,
} from './config/index.js'

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
export type { Locale, LocaleConfig, LocaleStrings } from './i18n/locale-manager.js'
export { EN_STRINGS, LocaleManager } from './i18n/locale-manager.js'
