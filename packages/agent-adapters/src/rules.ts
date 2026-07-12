/**
 * Rule-aware adapter runtime helpers.
 *
 * This subpath is the narrow bridge between canonical RuntimePlan output from
 * `@dzupagent/adapter-rules` and adapter execution inputs. It deliberately
 * accepts an already-compiled plan so rule loading, validation, and policy
 * source selection remain host-owned.
 */

import * as os from 'node:os'

import {
  RuleCompiler,
  RuleLoader,
  type AdapterRule,
  type CompileContext,
  type RuleLoadDiagnostic,
  type RuntimePlan,
} from '@dzupagent/adapter-rules'

import type { AdapterConfig, AdapterProviderId, AgentInput, GovernanceEvent } from './types.js'

export const ADAPTER_RULE_RUNTIME_PLAN_OPTION = 'adapterRulesRuntimePlan'
export const ADAPTER_RULE_PROVIDER_CONFIG_PATCH_OPTION = 'adapterRuleProviderConfigPatch'
export const ADAPTER_RULE_AUDIT_FLAGS_OPTION = 'adapterRuleAuditFlags'
export const ADAPTER_RULE_DENIED_PATHS_OPTION = 'adapterRuleDeniedPaths'
export const ADAPTER_RULE_ALERTS_OPTION = 'adapterRuleAlerts'
export const ADAPTER_RULE_MONITOR_SUBSCRIPTIONS_OPTION = 'adapterRuleMonitorSubscriptions'

export interface RuntimePlanInputOptions {
  /**
   * Append `RuntimePlan.promptSections` to `AgentInput.systemPrompt`.
   * Enabled by default because prompt sections are part of the canonical plan.
   */
  applyPromptSections?: boolean | undefined
}

export interface RuntimePlanProjectionOptions extends RuntimePlanInputOptions {
  /** Existing adapter config to merge with rule-derived config overrides. */
  config?: Partial<AdapterConfig> | undefined
}

export interface RuntimePlanGuardrailProjection {
  auditFlags: string[]
  deniedPaths: string[]
  requiredSkills: string[]
  preferredAgent?: string | undefined
}

export interface RuntimePlanAdapterProjection {
  input: AgentInput
  config: Partial<AdapterConfig>
  guardrails: RuntimePlanGuardrailProjection
}

export type AdapterRuleRuntimeDiagnosticCode = RuleLoadDiagnostic['code'] | 'compile_error'

export interface AdapterRuleRuntimeDiagnostic {
  code: AdapterRuleRuntimeDiagnosticCode
  ruleId: string
  severity: 'warn' | 'block'
  detail: string
  source?: string | undefined
  ruleIndex?: number | undefined
  errors?: string[] | undefined
}

export interface PrepareAdapterRuleRuntimeOptions extends RuntimePlanProjectionOptions {
  /** Already-loaded rules to include before rules loaded from disk. */
  rules?: readonly AdapterRule[] | undefined
  /** Optional single JSON rule file to load before compiling. */
  ruleFile?: string | undefined
  /** Optional directory of JSON rule files to load before compiling. */
  ruleDirectory?: string | undefined
  /** Test/host seam for custom loaders. */
  loader?: Pick<RuleLoader, 'loadFileWithDiagnostics' | 'loadFromDirectoryWithDiagnostics'> | undefined
  /** Test/host seam for custom compilers. */
  compiler?: Pick<RuleCompiler, 'compile'> | undefined
  /**
   * Optional governance sink. Load diagnostics are emitted as warn-level rule
   * violations; compiler failures are emitted as blocking rule violations.
   */
  emitGovernanceEvent?: ((event: GovernanceEvent) => void) | undefined
  runId?: string | undefined
  sessionId?: string | undefined
  timestamp?: number | undefined
}

export interface PreparedAdapterRuleRuntime extends RuntimePlanAdapterProjection {
  plan: RuntimePlan
  rules: AdapterRule[]
  diagnostics: AdapterRuleRuntimeDiagnostic[]
  governanceEvents: GovernanceEvent[]
}

/**
 * Attach a compiled RuntimePlan to an AgentInput so provider adapters can
 * consume rule-derived runtime metadata during execution.
 */
export function withAdapterRuleRuntimePlan(
  input: AgentInput,
  plan: RuntimePlan,
  options: RuntimePlanInputOptions = {},
): AgentInput {
  return projectAdapterRuleRuntimePlan(input, plan, options).input
}

/**
 * Load canonical adapter rules, compile a provider RuntimePlan, project it
 * onto adapter input/config, and optionally emit governance-plane diagnostics.
 *
 * This is the first-class host helper for rule-aware execution. Callers no
 * longer need to separately load rule files, call RuleCompiler, attach the
 * plan, and convert loader/compiler failures into governance events.
 */
export async function prepareAdapterRuleRuntime(
  input: AgentInput,
  context: CompileContext,
  options: PrepareAdapterRuleRuntimeOptions = {},
): Promise<PreparedAdapterRuleRuntime> {
  const loader = options.loader ?? new RuleLoader()
  const compiler = options.compiler ?? new RuleCompiler()
  const rules: AdapterRule[] = [...(options.rules ?? [])]
  const diagnostics: AdapterRuleRuntimeDiagnostic[] = []

  if (options.ruleFile) {
    const result = await loader.loadFileWithDiagnostics(options.ruleFile)
    rules.push(...result.rules)
    diagnostics.push(...result.diagnostics.map(toAdapterRuleRuntimeDiagnostic))
  }

  if (options.ruleDirectory) {
    const result = await loader.loadFromDirectoryWithDiagnostics(options.ruleDirectory)
    rules.push(...result.rules)
    diagnostics.push(...result.diagnostics.map(toAdapterRuleRuntimeDiagnostic))
  }

  let plan: RuntimePlan
  try {
    plan = compiler.compile(rules, context)
  } catch (err) {
    diagnostics.push({
      code: 'compile_error',
      ruleId: 'rule_compile_error',
      severity: 'block',
      detail: `Rule compiler failed: ${formatErrorMessage(err)}`,
    })
    plan = emptyRuntimePlan(context.providerId)
  }

  const projection = projectAdapterRuleRuntimePlan(input, plan, options)
  const governanceEvents = diagnostics.map((diagnostic) =>
    diagnosticToGovernanceEvent(diagnostic, input, context, options),
  )
  if (options.emitGovernanceEvent) {
    for (const event of governanceEvents) options.emitGovernanceEvent(event)
  }

  return {
    ...projection,
    plan,
    rules,
    diagnostics,
    governanceEvents,
  }
}

/**
 * Project a compiled RuntimePlan into the adapter-facing input/config pair.
 *
 * The function performs only safe, in-process projection:
 * - attaches the plan for runtime consumers such as BaseCliAdapter watchers
 * - appends prompt sections by default
 * - carries plan metadata in AgentInput.options for hosts/guardrails
 * - applies direct provider option mappings where the current adapters already
 *   consume those options
 * - preserves provider config patches under providerOptions so callers can
 *   inspect or apply provider-native config without losing data
 */
export function projectAdapterRuleRuntimePlan(
  input: AgentInput,
  plan: RuntimePlan,
  options: RuntimePlanProjectionOptions = {},
): RuntimePlanAdapterProjection {
  const applyPromptSections = options.applyPromptSections ?? true
  const inputOptions: Record<string, unknown> = {
    ...(input.options ?? {}),
    [ADAPTER_RULE_RUNTIME_PLAN_OPTION]: plan,
  }
  const config: Partial<AdapterConfig> = { ...(options.config ?? {}) }
  const providerConfigPatch = plan.providerConfigPatch

  if (Object.keys(providerConfigPatch).length > 0) {
    inputOptions[ADAPTER_RULE_PROVIDER_CONFIG_PATCH_OPTION] = providerConfigPatch
    config.providerOptions = {
      ...(config.providerOptions ?? {}),
      [ADAPTER_RULE_PROVIDER_CONFIG_PATCH_OPTION]: providerConfigPatch,
    }
  }
  if (plan.auditFlags.length > 0) {
    inputOptions[ADAPTER_RULE_AUDIT_FLAGS_OPTION] = [...plan.auditFlags]
  }
  if (plan.deniedPaths.length > 0) {
    inputOptions[ADAPTER_RULE_DENIED_PATHS_OPTION] = [...plan.deniedPaths]
  }
  if (plan.alerts.length > 0) {
    inputOptions[ADAPTER_RULE_ALERTS_OPTION] = plan.alerts.map((alert) => ({ ...alert }))
  }
  if (plan.monitorSubscriptions.length > 0) {
    inputOptions[ADAPTER_RULE_MONITOR_SUBSCRIPTIONS_OPTION] = [
      ...plan.monitorSubscriptions,
    ]
  }

  applyProviderRuntimePatch(plan.providerId, providerConfigPatch, inputOptions, config)

  return {
    input: {
      ...input,
      systemPrompt: applyPromptSections
        ? appendPromptSections(input.systemPrompt, plan.promptSections)
        : input.systemPrompt,
      options: inputOptions,
    },
    config,
    guardrails: {
      auditFlags: [...plan.auditFlags],
      deniedPaths: [...plan.deniedPaths],
      requiredSkills: [...plan.requiredSkills],
      preferredAgent: plan.preferredAgent,
    },
  }
}

/**
 * Read a RuntimePlan attached by withAdapterRuleRuntimePlan(). Unknown option
 * shapes are ignored so untrusted input cannot break adapter execution.
 */
export function getAdapterRuleRuntimePlan(
  input: AgentInput,
  providerId?: AdapterProviderId,
): RuntimePlan | undefined {
  const candidate = input.options?.[ADAPTER_RULE_RUNTIME_PLAN_OPTION]
  if (!isRuntimePlanLike(candidate)) return undefined
  if (providerId !== undefined && candidate.providerId !== providerId) return undefined
  return candidate
}

/**
 * Resolve all watcher paths carried by a RuntimePlan into concrete filesystem
 * paths suitable for the BaseCliAdapter watcher factory.
 */
export function resolveRuntimePlanWatcherPaths(
  plan: RuntimePlan,
  workingDirectory: string,
): string[] {
  const paths = [
    ...plan.watcherRegistrations.map((registration) => registration.path),
    ...plan.watchPaths,
  ]
  return dedupe(paths.map((path) => resolveAdapterWatchPath(path, workingDirectory)))
}

/**
 * Resolve a project/home watch-spec entry to an absolute path. `~` and `~/...`
 * are expanded against the current user's home directory; anything else is
 * resolved against the supplied working directory unless already absolute.
 */
export function resolveAdapterWatchPath(entry: string, workingDirectory: string): string {
  if (entry === '~') return os.homedir()
  if (entry.startsWith('~/')) return normalizeWatchPath(`${os.homedir()}/${entry.slice(2)}`)
  if (entry.startsWith('/')) return normalizeWatchPath(entry)
  return normalizeWatchPath(`${workingDirectory.replace(/\/$/, '')}/${entry}`)
}

function appendPromptSections(
  systemPrompt: string | undefined,
  promptSections: readonly string[],
): string | undefined {
  const sections = promptSections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
  if (sections.length === 0) return systemPrompt
  if (systemPrompt === undefined || systemPrompt.trim().length === 0) {
    return sections.join('\n\n')
  }
  return [systemPrompt, ...sections].join('\n\n')
}

function isRuntimePlanLike(value: unknown): value is RuntimePlan {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<RuntimePlan>
  return (
    typeof record.providerId === 'string' &&
    Array.isArray(record.promptSections) &&
    Array.isArray(record.watchPaths) &&
    Array.isArray(record.watcherRegistrations) &&
    record.providerConfigPatch !== null &&
    typeof record.providerConfigPatch === 'object'
  )
}

function toAdapterRuleRuntimeDiagnostic(
  diagnostic: RuleLoadDiagnostic,
): AdapterRuleRuntimeDiagnostic {
  return {
    code: diagnostic.code,
    ruleId: 'adapter_rule_load_error',
    severity: 'warn',
    detail: diagnostic.message,
    source: diagnostic.source,
    ruleIndex: diagnostic.ruleIndex,
    errors: diagnostic.errors,
  }
}

function diagnosticToGovernanceEvent(
  diagnostic: AdapterRuleRuntimeDiagnostic,
  input: AgentInput,
  context: CompileContext,
  options: PrepareAdapterRuleRuntimeOptions,
): GovernanceEvent {
  return {
    type: 'governance:rule_violation',
    runId: options.runId ?? input.correlationId ?? '',
    providerId: context.providerId,
    timestamp: options.timestamp ?? Date.now(),
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    detail: diagnostic.detail,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  }
}

function emptyRuntimePlan(providerId: AdapterProviderId): RuntimePlan {
  return {
    providerId,
    promptSections: [],
    requiredSkills: [],
    preferredAgent: undefined,
    providerConfigPatch: {},
    monitorSubscriptions: [],
    watchPaths: [],
    auditFlags: [],
    deniedPaths: [],
    alerts: [],
    watcherRegistrations: [],
  }
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message
  return String(err)
}

function applyProviderRuntimePatch(
  providerId: AdapterProviderId,
  providerConfigPatch: Record<string, unknown>,
  inputOptions: Record<string, unknown>,
  config: Partial<AdapterConfig>,
): void {
  switch (providerId) {
    case 'codex':
      applyStringInputOptionIfAbsent(
        inputOptions,
        'approvalPolicy',
        providerConfigPatch['approvalPolicy'],
      )
      return

    case 'claude':
      if (Object.keys(providerConfigPatch).length > 0) {
        config.providerOptions = {
          ...(config.providerOptions ?? {}),
          ...providerConfigPatch,
        }
      }
      return

    case 'goose': {
      applyStringInputOptionIfAbsent(inputOptions, 'gooseMode', providerConfigPatch['GOOSE_MODE'])
      return
    }

    default:
      return
  }
}

function applyStringInputOptionIfAbsent(
  inputOptions: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof inputOptions[key] === 'string') return
  if (typeof value === 'string' && value.length > 0) {
    inputOptions[key] = value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)]
}

function normalizeWatchPath(path: string): string {
  if (path === '/') return path
  return path.replace(/\/+$/, '')
}
