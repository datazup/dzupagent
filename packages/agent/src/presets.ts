/**
 * @dzupagent/agent/presets — agent preset registry and built-in presets.
 *
 * Re-exports the preset subsystem for hosts that resolve agent configurations
 * by preset name. Use this subpath to instantiate the PresetRegistry, register
 * custom presets, or call buildConfigFromPreset directly.
 */

export * from './presets/index.js'
