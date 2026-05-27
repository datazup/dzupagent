/**
 * Per-provider aggregate view consumed by adapter-monitor dashboards.
 *
 * Each numeric metric is nullable so the dashboard can distinguish a measured
 * value of zero from an unavailable measurement (for example when a provider's
 * monitor tier does not expose that signal, or the watcher has never run).
 */
export interface AdapterMonitorDashboardContract {
  /** Stable provider identifier (e.g. `'claude'`, `'codex'`). */
  providerId: string
  /** Depth of monitor introspection the provider supports. */
  monitorTier: 'deep' | 'partial' | 'artifact-backed' | 'none'
  /** Coarse activation state of the artifact watcher for this provider. */
  watcherState: 'active' | 'not_configured' | 'stopped'
  /** Count of raw SDK/CLI events observed, or `null` when unavailable. */
  rawEventCount: number | null
  /** Count of normalized DzupAgent events emitted, or `null` when unavailable. */
  normalizedEventCount: number | null
  /** Count of artifacts captured by the watcher, or `null` when unavailable. */
  artifactCount: number | null
  /** Count of tool calls observed, or `null` when unavailable. */
  toolCallCount: number | null
  /** Count of approval prompts surfaced, or `null` when unavailable. */
  approvalPromptCount: number | null
  /** Count of MCP tool invocations, or `null` when unavailable. */
  mcpToolUsageCount: number | null
  /** How MCP tools were exposed to the provider, or `null` when not applicable. */
  mcpMode: 'native' | 'system-prompt-fallback' | null
  /** Accumulated cost in micro-dollars, or `null` when unavailable. */
  costMicros: number | null
  /** Total tokens consumed (input + output), or `null` when unavailable. */
  totalTokens: number | null
  /** Number of recovery retries attempted, or `null` when unavailable. */
  retryCount: number | null
  /** Number of fallbacks to another adapter, or `null` when unavailable. */
  fallbackCount: number | null
  /** Fraction of successful runs in `[0, 1]`, or `null` when unavailable. */
  successRate: number | null
}
