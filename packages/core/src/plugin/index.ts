export type {
  DzupPlugin,
  PluginContext,
  PluginSource,
  PluginRegistrationOptions,
  PluginRegistrationConflictDiagnostic,
  PluginDisposeResult,
} from './plugin-types.js'
export { PluginRegistry, PluginRegistrationConflictError } from './plugin-registry.js'
export { composeAgentHooks } from './plugin-hooks.js'
export type { ComposeAgentHooksOptions } from './plugin-hooks.js'
