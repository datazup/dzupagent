import type { AdapterProviderId } from './types.js'

export type MonitorTier = 'deep' | 'partial' | 'artifact-backed' | 'none'

export interface ProviderCapabilities {
  runtimeExecution: boolean
  productIntegrated: boolean
  httpAdapterRouting: boolean
  monitorIntrospection: MonitorTier
  supportsReplay: boolean
  supportsPolicyProjection: boolean
  supportsSkillProjection: boolean
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
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  codex: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'deep',
    supportsReplay: true,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  gemini: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'partial',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  qwen: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'partial',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  goose: {
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: true,
    monitorIntrospection: 'artifact-backed',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  crush: {
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: true,
    monitorIntrospection: 'artifact-backed',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  'gemini-sdk': {
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: false,
    monitorIntrospection: 'none',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  openrouter: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'none',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
  },
  openai: {
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'none',
    supportsReplay: false,
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
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
