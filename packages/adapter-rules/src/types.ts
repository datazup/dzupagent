/**
 * Canonical rule schema and runtime plan projection types.
 *
 * Rules are canonical; provider config, prompts, hooks, skills, and monitors
 * are projections. See docs/agent-adapters/05-rules-runtime-and-configuration.md
 * for design rationale.
 */

import type { AdapterProviderId } from '@dzupagent/adapter-types'

// ---------------------------------------------------------------------------
// Rule schema primitives
// ---------------------------------------------------------------------------

export type RuleScope = 'global' | 'workspace' | 'project' | 'path'

export type RuleEffectKind =
  | 'prompt_section'
  | 'require_skill'
  | 'prefer_agent'
  | 'require_approval'
  | 'deny_path'
  | 'watch_path'
  | 'emit_alert'

export type PromptSectionPurpose = 'persona' | 'style' | 'safety' | 'task' | 'output'
export type ApprovalTarget = 'bash' | 'network' | 'write' | 'tool'
export type AlertSeverity = 'info' | 'warning' | 'error'

export type RuleEffect =
  | { kind: 'prompt_section'; purpose: PromptSectionPurpose; content: string }
  | { kind: 'require_skill'; skill: string }
  | { kind: 'prefer_agent'; agent: string }
  | { kind: 'require_approval'; target: ApprovalTarget }
  | { kind: 'deny_path'; path: string }
  | { kind: 'watch_path'; path: string; artifactKind: string }
  | { kind: 'emit_alert'; on: string; severity: AlertSeverity }

export interface RuleMatch {
  paths?: string[] | undefined
  requestTags?: string[] | undefined
  models?: string[] | undefined
  eventTypes?: string[] | undefined
}

export interface AdapterRule {
  id: string
  name: string
  scope: RuleScope
  /** Provider IDs this rule applies to. `'*'` means all providers. */
  appliesToProviders: string[]
  match?: RuleMatch | undefined
  effects: RuleEffect[]
}

// ---------------------------------------------------------------------------
// Runtime plan — output of the compiler
// ---------------------------------------------------------------------------

export interface RuntimePlanAlert {
  on: string
  severity: AlertSeverity
}

export type WatcherRegistration = {
  path: string
  provider: string
  watchClass: 'project' | 'home' | 'artifact' | 'dzupagent'
  description?: string
}

export interface RuntimePlan {
  providerId: AdapterProviderId
  promptSections: string[]
  requiredSkills: string[]
  preferredAgent?: string | undefined
  providerConfigPatch: Record<string, unknown>
  monitorSubscriptions: string[]
  watchPaths: string[]
  auditFlags: string[]
  deniedPaths: string[]
  alerts: RuntimePlanAlert[]
  watcherRegistrations: WatcherRegistration[]
}

/**
 * Context used to evaluate rules at compile time.
 * All fields other than `providerId` are optional — when omitted, match
 * filters that depend on them are skipped (treated as not-a-filter).
 *
 * `apiKey`, `providerName`, and `maxTokens` are consumed by provider config
 * projectors to produce native-format config patches (for example,
 * `~/.gemini/settings.json`, `~/.qwen/config.json`, `.goose/config.yaml`,
 * `.crush/config.toml`). They are not used for rule matching.
 */
export interface CompileContext {
  providerId: AdapterProviderId
  pathScope?: string | undefined
  requestTags?: string[] | undefined
  model?: string | undefined
  apiKey?: string | undefined
  providerName?: string | undefined
  maxTokens?: number | undefined
  /**
   * Workspace root used as the base for relative filesystem paths emitted by
   * watcher-registration projectors. When omitted, relative paths are emitted
   * as-is (relative to the runtime's current working directory).
   */
  workspaceDir?: string | undefined
}
