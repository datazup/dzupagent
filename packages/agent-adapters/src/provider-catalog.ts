import type { AdapterProviderId } from './types.js'
import type { AdapterMonitorStatus } from './types.js'

export type MonitorTier = 'deep' | 'partial' | 'artifact-backed' | 'none'
export type ApprovalSupportTier = 'native' | 'provider-config' | 'host-gated'
export type ToolControlSupportTier = 'native' | 'provider-config' | 'host-gated' | 'none'

export interface ProviderToolControlSupport {
  mode: ToolControlSupportTier
  allowlist: ToolControlSupportTier
  blocklist: ToolControlSupportTier
}

export interface ProviderCapabilities {
  runtimeExecution: boolean
  productIntegrated: boolean
  httpAdapterRouting: boolean
  monitorIntrospection: MonitorTier
  supportsReplay: boolean
  /**
   * Distinguishes approval behavior by enforcement surface:
   * - native: AdapterPolicy can map approval directly into runtime config/options.
   * - provider-config: adapter-rules can project approval into provider config,
   *   but AdapterPolicy callers still need a rule-aware bridge or host gate.
   * - host-gated: approval must be enforced by the host/orchestrator.
   */
  approvalSupport: ApprovalSupportTier
  /**
   * True when the provider has a native/provider-config projection path for
   * policy effects. Generic policy compiler guardrail hints are not enough for
   * this flag; API-only providers can still receive maxTurns or host-side
   * guardrails without advertising native projection support.
   */
  supportsPolicyProjection: boolean
  supportsSkillProjection: boolean
  toolControlSupport: ProviderToolControlSupport
}

/**
 * Provider productization policy
 * ------------------------------
 * The following providers are CORE-ONLY and NOT PRODUCTIZED in the Codev
 * product surface at this time:
 *   - goose        (productIntegrated: false)
 *   - crush        (productIntegrated: false)
 *   - gemini-sdk   (productIntegrated: false)
 *
 * They remain fully supported at the framework/adapter level (runtime
 * execution, policy + skill projection) but are intentionally excluded
 * from `getProductProviders()` so the product UI, onboarding, billing,
 * and registration flows do not surface them. The `productIntegrated`
 * flag on each entry in PROVIDER_CATALOG below is the single source of
 * truth for this decision.
 *
 * HTTP adapter routing is a separate framework policy. Providers with
 * `httpAdapterRouting: true` are accepted by AdapterHttpHandler request
 * schemas. `openai` is intentionally product-integrated and HTTP-routable
 * because the package exports a first-party OpenAIAdapter.
 *
 * This decision can be revisited to promote any of them to an
 * experimental / opt-in product tier by flipping `productIntegrated` to
 * true (and updating the relevant catalog/UI tests).
 */
export const PROVIDER_CATALOG = {
  claude: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'deep',
    supportsReplay: true,
    approvalSupport: 'native',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  codex: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'deep',
    supportsReplay: true,
    approvalSupport: 'native',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'native', allowlist: 'native', blocklist: 'native' },
  },
  gemini: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'partial',
    supportsReplay: false,
    approvalSupport: 'provider-config',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  qwen: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'partial',
    supportsReplay: false,
    approvalSupport: 'provider-config',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  goose: {
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: true,
    monitorIntrospection: 'artifact-backed',
    supportsReplay: false,
    approvalSupport: 'provider-config',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  crush: {
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: true,
    monitorIntrospection: 'artifact-backed',
    supportsReplay: false,
    approvalSupport: 'provider-config',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  'gemini-sdk': {
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: false,
    monitorIntrospection: 'none',
    supportsReplay: false,
    approvalSupport: 'provider-config',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  openrouter: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'none',
    supportsReplay: false,
    approvalSupport: 'host-gated',
    supportsPolicyProjection: false,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'none', blocklist: 'none' },
  },
  openai: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'none',
    supportsReplay: false,
    approvalSupport: 'host-gated',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'native', allowlist: 'native', blocklist: 'native' },
  },
} satisfies Record<AdapterProviderId, ProviderCapabilities>

export const HTTP_ROUTABLE_PROVIDER_IDS = Object.freeze(
  (Object.entries(PROVIDER_CATALOG) as Array<[AdapterProviderId, ProviderCapabilities]>)
    .filter(([, caps]) => caps.httpAdapterRouting)
    .map(([id]) => id),
) as readonly AdapterProviderId[]

/** Returns provider IDs where monitor introspection is supported (tier !== 'none'). */
export function getMonitorableProviders(): AdapterProviderId[] {
  return Object.entries(PROVIDER_CATALOG)
    .filter(([, caps]) => caps.monitorIntrospection !== 'none')
    .map(([id]) => id as AdapterProviderId)
}

/** Returns provider IDs registered in the Codev product (productIntegrated === true). */
export function getProductProviders(): AdapterProviderId[] {
  return Object.entries(PROVIDER_CATALOG)
    .filter(([, caps]) => caps.productIntegrated)
    .map(([id]) => id as AdapterProviderId)
}

/** Returns capabilities for a given provider ID, or undefined if unknown. */
export function getProviderCapabilities(id: string): ProviderCapabilities | undefined {
  return PROVIDER_CATALOG[id as AdapterProviderId]
}

/** Returns the default idle monitor status implied by provider catalog metadata. */
export function getDefaultMonitorStatus(providerId: AdapterProviderId): AdapterMonitorStatus {
  const tier = getProviderCapabilities(providerId)?.monitorIntrospection ?? 'none'
  if (tier === 'none') {
    return {
      state: 'unsupported',
      supported: false,
      monitorIntrospection: tier,
    }
  }
  return {
    state: 'not_configured',
    supported: true,
    monitorIntrospection: tier,
  }
}
