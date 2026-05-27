/** Strategy for injecting project memory into Codex runs */
export type CodexMemoryStrategy =
  | 'inject-always'
  | 'inject-on-new-thread'
  | 'trust-thread-history'

/** Versioned schema identifier for `.dzupagent/config.json`. */
export type DzupAgentConfigSchemaId = 'dzupagent-config/v1'

/**
 * `provider` namespace — default provider/model routing for adapters.
 * Open-ended object: keys are provider/adapter ids, values are arbitrary
 * provider-specific settings. Validated downstream, not here.
 */
export interface DzupAgentProviderConfig {
  /** Default adapter/provider id to route to when none is specified. */
  default?: string | undefined
  /** Per-provider settings keyed by provider id. */
  [providerId: string]: unknown
}

/**
 * `mcp` namespace — Model Context Protocol server registrations.
 * Open-ended: keys are MCP server names, values are server definitions.
 */
export interface DzupAgentMcpConfig {
  /** MCP server definitions keyed by server name. */
  servers?: Record<string, unknown> | undefined
  [key: string]: unknown
}

/**
 * `monitor` namespace — observability / adapter-monitor toggles.
 */
export interface DzupAgentMonitorConfig {
  /** Whether adapter monitoring is enabled. */
  enabled?: boolean | undefined
  [key: string]: unknown
}

/**
 * `rules` namespace — guardrail / policy rules surfaced to adapters.
 */
export interface DzupAgentRulesConfig {
  /** Ordered list of rule identifiers or inline rule strings. */
  rules?: string[] | undefined
  [key: string]: unknown
}

/**
 * `privacy` namespace — redaction / data-handling preferences.
 */
export interface DzupAgentPrivacyConfig {
  /** Whether to redact secrets before they reach a provider. Default: true. */
  redactSecrets?: boolean | undefined
  [key: string]: unknown
}

/**
 * Global/workspace/project DzupAgent configuration (`.dzupagent/config.json`).
 *
 * Tiered merge model (same as skills): global < workspace < project. Each
 * namespace is shallow-merged across tiers. All namespaces are optional so
 * existing `codex`/`memory`/`sync` callers continue to work without migration.
 */
export interface AdapterMemoryConfig {
  /** Versioned schema identifier. Preserved from the winning (highest) tier. */
  $schema?: DzupAgentConfigSchemaId | string | undefined
  /** Default provider/model routing. */
  provider?: DzupAgentProviderConfig | undefined
  /** MCP server registrations. */
  mcp?: DzupAgentMcpConfig | undefined
  /** Observability / adapter-monitor toggles. */
  monitor?: DzupAgentMonitorConfig | undefined
  /** Guardrail / policy rules. */
  rules?: DzupAgentRulesConfig | undefined
  /** Redaction / data-handling preferences. */
  privacy?: DzupAgentPrivacyConfig | undefined
  codex?: {
    /** How to handle memory injection for Codex. Default: 'inject-on-new-thread' */
    memoryStrategy?: CodexMemoryStrategy | undefined
  }
  memory?: {
    /** Max tokens to inject per run. Default: 2000 */
    maxTokens?: number | undefined
    /** Include global (~/.dzupagent/memory/) entries. Default: true */
    includeGlobal?: boolean | undefined
    /** Include workspace-level entries. Default: true */
    includeWorkspace?: boolean | undefined
  }
  sync?: {
    /** Auto-sync to native files on project open. Default: false */
    onProjectOpen?: boolean | undefined
  }
}

/** Public name for the tiered `.dzupagent/config.json` shape. */
export type DzupAgentConfig = AdapterMemoryConfig

/** Resolved filesystem paths for a project's .dzupagent/ context */
export interface DzupAgentPaths {
  /** ~/.dzupagent/ */
  globalDir: string
  /** <git-root>/.dzupagent/ — workspace level, undefined if same as project */
  workspaceDir: string | undefined
  /** <project>/.dzupagent/ */
  projectDir: string
  /** <project>/.dzupagent/state.json */
  stateFile: string
  /** <project>/.dzupagent/config.json */
  projectConfig: string
}
