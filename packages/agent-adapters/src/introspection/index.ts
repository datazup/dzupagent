/** Public adapter installation introspection and manifest-building surface. */
export {
  AdapterInstallationInspector,
  PROBE_TOOL_VERSION,
  observed,
  unspecified,
  unspecifiedCrud,
} from './adapter-installation-inspector.js'
export type {
  ConfigLayerCandidate,
  InspectorContext,
} from './adapter-installation-inspector.js'
export { ClaudeInstallationInspector } from './claude-inspector.js'
export { CodexInstallationInspector } from './codex-inspector.js'
export { GeminiInstallationInspector } from './gemini-inspector.js'
export { QwenInstallationInspector } from './qwen-inspector.js'
export { PARTIAL_INSPECTOR_GAPS } from './partial-inspector-gaps.js'
export {
  buildCapabilityManifest,
  computeManifestHash,
  detectCapabilityDrift,
  effectiveCapability,
  effectiveCapabilityValue,
  reprobeTriggers,
} from './capability-manifest-builder.js'
export {
  ObservedCapabilitiesLiveSubscriber,
  reduceRunEventsToObservedCapabilities,
  replayObservedCapabilities,
} from './observed-capabilities-reducer.js'
export type {
  ObservationCycle,
  ObservedCapabilitiesReducerInput,
  ObservedRunEvent,
  ObservedRunEventSource,
} from './observed-capabilities-reducer.js'
export type {
  BuildManifestInput,
  CapabilityDriftFinding,
  DriftedCapability,
  EffectiveCapabilityValue,
  ReprobeTrigger,
} from './capability-manifest-builder.js'
export {
  DEFAULT_PROBE_KILL_GRACE_MS,
  DEFAULT_PROBE_OUTPUT_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_TOTAL_DURATION_MS,
  PROBE_ENV_ALLOWLIST,
  buildProbeEnv,
  parseHelpFlags,
  parseHelpSubcommands,
  parseVersion,
  redactProbeText,
} from './probe-runner.js'
export type {
  ProbeCommand,
  ProbeEnvOptions,
  ProbeFailureClassification,
  ProbeResult,
  SafeProbeCommandRunner,
} from './probe-runner.js'
export {
  createNodeProbeRunner,
  resolveNodeProbeExecutable,
} from './node-probe-runner.js'
export type {
  NodeProbeRunnerOptions,
  ProbeRunnerLimits,
  ResolvedProbeExecutable,
} from './node-probe-runner.js'
export {
  DEFAULT_HELP_WALK_LIMITS,
  DENIED_HELP_COMMANDS,
  walkHelpTree,
} from './help-walker.js'
export type {
  HelpWalkCompleteness,
  HelpWalkFinding,
  HelpWalkLimits,
  HelpWalkOptions,
  HelpWalkPartialReason,
  HelpWalkResult,
} from './help-walker.js'
