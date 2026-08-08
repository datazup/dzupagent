import type {
  AdapterCapabilityProfile,
  AdapterMonitorStatus,
  AdapterProviderId,
  CatalogEntry,
  EventFidelity,
} from './types.js'

export type MonitorTier = CatalogEntry['monitorTier']
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
 * Canonical layer-1 catalog record (WP-M1.2).
 *
 * The legacy execution-policy fields remain at the top level so existing
 * routers do not need a flag-day migration. `monitorIntrospection` is an
 * explicitly checked compatibility alias for the canonical `monitorTier`.
 */
export interface ProviderCatalogEntry extends ProviderCapabilities, CatalogEntry {
  monitorIntrospection: CatalogEntry['monitorTier']
}

const normalizedOnly: EventFidelity = {
  raw: false,
  normalized: true,
  artifact: false,
  governance: false,
  usage: 'none',
}

function postureRef(id: string): CatalogEntry['posture'] {
  return { postureId: `adapter-posture/${id}`, version: 1 }
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
    coordinates: { providerId: 'claude', backend: 'cli' },
    displayName: 'Claude Code',
    capabilityProfile: {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: true },
      providerRequestCorrelation: {
        idempotencyKey: { accepted: false, enforcement: 'none' },
        restartLookup: { supported: false, lookupBy: [] },
      },
    },
    monitorTier: 'deep',
    posture: postureRef('claude-cli'),
    lifecycleRecipeRef: 'lifecycle/claude-cli',
    eventFidelity: { ...normalizedOnly, governance: true, usage: 'parsed' },
    upstream: {
      repo: 'anthropics/claude-code',
      docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
      releaseFeed: 'https://github.com/anthropics/claude-code/releases.atom',
    },
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'deep',
    supportsReplay: true,
    approvalSupport: 'native',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'none', allowlist: 'native', blocklist: 'native' },
  },
  codex: {
    coordinates: { providerId: 'codex', backend: 'cli' },
    displayName: 'Codex CLI',
    capabilityProfile: {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: true },
      providerRequestCorrelation: {
        idempotencyKey: { accepted: false, enforcement: 'none' },
        restartLookup: { supported: false, lookupBy: [] },
      },
    },
    monitorTier: 'deep',
    posture: postureRef('codex-cli'),
    lifecycleRecipeRef: 'lifecycle/codex-cli',
    eventFidelity: {
      ...normalizedOnly,
      raw: true,
      governance: true,
      usage: 'parsed',
    },
    upstream: {
      repo: 'openai/codex',
      docsUrl: 'https://developers.openai.com/codex/cli/',
      releaseFeed: 'https://github.com/openai/codex/releases.atom',
    },
    runtimeExecution: true,
    productIntegrated: true,
    httpAdapterRouting: true,
    monitorIntrospection: 'deep',
    supportsReplay: true,
    approvalSupport: 'native',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'host-gated', allowlist: 'host-gated', blocklist: 'host-gated' },
  },
  gemini: {
    coordinates: { providerId: 'gemini', backend: 'cli' },
    displayName: 'Gemini CLI',
    capabilityProfile: {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: false },
    },
    monitorTier: 'partial',
    posture: postureRef('gemini-cli'),
    lifecycleRecipeRef: 'lifecycle/gemini-cli',
    eventFidelity: { ...normalizedOnly, usage: 'parsed' },
    upstream: {
      repo: 'google-gemini/gemini-cli',
      docsUrl: 'https://geminicli.com/docs/',
      releaseFeed: 'https://github.com/google-gemini/gemini-cli/releases.atom',
    },
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
    coordinates: { providerId: 'qwen', backend: 'cli' },
    displayName: 'Qwen Code',
    capabilityProfile: {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: true },
    },
    monitorTier: 'partial',
    posture: postureRef('qwen-cli'),
    lifecycleRecipeRef: 'lifecycle/qwen-cli',
    eventFidelity: { ...normalizedOnly, usage: 'parsed' },
    upstream: {
      repo: 'QwenLM/qwen-code',
      docsUrl: 'https://qwenlm.github.io/qwen-code-docs/',
      releaseFeed: 'https://github.com/QwenLM/qwen-code/releases.atom',
    },
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
    coordinates: { providerId: 'goose', backend: 'cli' },
    displayName: 'Goose',
    capabilityProfile: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: false,
      supportsCostUsage: false,
      nativeToolControls: { mode: false, allowlist: false, blocklist: false },
    },
    monitorTier: 'artifact-backed',
    posture: postureRef('goose-cli'),
    lifecycleRecipeRef: 'lifecycle/goose-cli',
    eventFidelity: normalizedOnly,
    upstream: {
      repo: 'block/goose',
      docsUrl: 'https://block.github.io/goose/',
      releaseFeed: 'https://github.com/block/goose/releases.atom',
    },
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
    coordinates: { providerId: 'crush', backend: 'cli' },
    displayName: 'Crush',
    capabilityProfile: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: false,
      supportsCostUsage: false,
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    },
    monitorTier: 'artifact-backed',
    posture: postureRef('crush-cli'),
    lifecycleRecipeRef: 'lifecycle/crush-cli',
    eventFidelity: normalizedOnly,
    upstream: {
      repo: 'charmbracelet/crush',
      docsUrl: 'https://github.com/charmbracelet/crush#readme',
      releaseFeed: 'https://github.com/charmbracelet/crush/releases.atom',
    },
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
    coordinates: { providerId: 'gemini-sdk', backend: 'sdk' },
    displayName: 'Gemini SDK',
    capabilityProfile: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: true,
    },
    monitorTier: 'none',
    posture: postureRef('gemini-sdk'),
    eventFidelity: { ...normalizedOnly, usage: 'native' },
    upstream: {
      repo: 'googleapis/js-genai',
      docsUrl: 'https://ai.google.dev/gemini-api/docs',
      releaseFeed: 'https://github.com/googleapis/js-genai/releases.atom',
    },
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
    coordinates: { providerId: 'openrouter', backend: 'http' },
    displayName: 'OpenRouter',
    capabilityProfile: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: true,
    },
    monitorTier: 'none',
    posture: postureRef('openrouter-http'),
    eventFidelity: { ...normalizedOnly, usage: 'native' },
    upstream: {
      repo: 'OpenRouterTeam/openrouter-examples',
      docsUrl: 'https://openrouter.ai/docs/quickstart',
    },
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
    coordinates: { providerId: 'openai', backend: 'http' },
    displayName: 'OpenAI',
    capabilityProfile: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    },
    monitorTier: 'none',
    posture: postureRef('openai-http'),
    eventFidelity: { ...normalizedOnly, usage: 'native' },
    upstream: {
      repo: 'openai/openai-node',
      docsUrl: 'https://developers.openai.com/api/docs/',
      releaseFeed: 'https://github.com/openai/openai-node/releases.atom',
    },
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
  ollama: {
    coordinates: { providerId: 'ollama', backend: 'http' },
    displayName: 'Ollama',
    capabilityProfile: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: false,
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    },
    monitorTier: 'partial',
    posture: postureRef('ollama-http'),
    eventFidelity: { ...normalizedOnly, usage: 'native' },
    upstream: {
      repo: 'ollama/ollama',
      docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
      releaseFeed: 'https://github.com/ollama/ollama/releases.atom',
    },
    runtimeExecution: true,
    productIntegrated: false,
    httpAdapterRouting: false,
    monitorIntrospection: 'partial',
    supportsReplay: false,
    approvalSupport: 'host-gated',
    supportsPolicyProjection: true,
    supportsSkillProjection: true,
    toolControlSupport: { mode: 'native', allowlist: 'native', blocklist: 'native' },
  },
} satisfies Record<AdapterProviderId, ProviderCatalogEntry>

/**
 * Runtime contract guard used by catalog loading and conformance tests.
 * TypeScript catches omissions in this source file; this guard also rejects
 * incomplete data loaded through JavaScript, JSON, or future plugin seams.
 */
export function assertProviderCatalogEntry(
  value: unknown,
  expectedProviderId?: AdapterProviderId,
): asserts value is ProviderCatalogEntry {
  if (!isRecord(value)) throw new TypeError('provider catalog entry must be an object')

  const coordinates = value.coordinates
  if (!isRecord(coordinates)) throw new TypeError('provider catalog entry missing coordinates')
  if (typeof coordinates.providerId !== 'string') {
    throw new TypeError('provider catalog entry missing coordinates.providerId')
  }
  if (expectedProviderId !== undefined && coordinates.providerId !== expectedProviderId) {
    throw new TypeError(`provider catalog key ${expectedProviderId} disagrees with coordinates.providerId`)
  }
  if (!['cli', 'sdk', 'http'].includes(String(coordinates.backend))) {
    throw new TypeError('provider catalog entry has invalid coordinates.backend')
  }

  if (typeof value.displayName !== 'string' || value.displayName.length === 0) {
    throw new TypeError('provider catalog entry missing displayName')
  }

  const profile = value.capabilityProfile
  if (!isRecord(profile)) throw new TypeError('provider catalog entry missing capabilityProfile')
  for (const field of [
    'supportsResume',
    'supportsFork',
    'supportsToolCalls',
    'supportsStreaming',
    'supportsCostUsage',
  ] satisfies Array<keyof AdapterCapabilityProfile>) {
    if (typeof profile[field] !== 'boolean') {
      throw new TypeError(`provider catalog capabilityProfile missing ${field}`)
    }
  }

  if (!['deep', 'partial', 'artifact-backed', 'none'].includes(String(value.monitorTier))) {
    throw new TypeError('provider catalog entry has invalid monitorTier')
  }
  if (value.monitorIntrospection !== value.monitorTier) {
    throw new TypeError('provider catalog monitorIntrospection alias disagrees with monitorTier')
  }
  if (typeof value.productIntegrated !== 'boolean') {
    throw new TypeError('provider catalog entry missing productIntegrated')
  }

  const posture = value.posture
  if (
    !isRecord(posture) ||
    typeof posture.postureId !== 'string' ||
    posture.postureId.length === 0 ||
    !Number.isInteger(posture.version) ||
    Number(posture.version) < 1
  ) {
    throw new TypeError('provider catalog entry has invalid posture reference')
  }
  if (value.lifecycleRecipeRef !== undefined && typeof value.lifecycleRecipeRef !== 'string') {
    throw new TypeError('provider catalog entry has invalid lifecycleRecipeRef')
  }

  const fidelity = value.eventFidelity
  if (!isRecord(fidelity)) throw new TypeError('provider catalog entry missing eventFidelity')
  for (const field of ['raw', 'normalized', 'artifact', 'governance'] as const) {
    if (typeof fidelity[field] !== 'boolean') {
      throw new TypeError(`provider catalog eventFidelity missing ${field}`)
    }
  }
  if (!['native', 'parsed', 'none'].includes(String(fidelity.usage))) {
    throw new TypeError('provider catalog entry has invalid eventFidelity.usage')
  }

  const upstream = value.upstream
  if (
    !isRecord(upstream) ||
    typeof upstream.repo !== 'string' ||
    upstream.repo.length === 0 ||
    typeof upstream.docsUrl !== 'string' ||
    upstream.docsUrl.length === 0
  ) {
    throw new TypeError('provider catalog entry has invalid upstream metadata')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

for (const [providerId, entry] of Object.entries(PROVIDER_CATALOG)) {
  assertProviderCatalogEntry(entry, providerId as AdapterProviderId)
}

export const HTTP_ROUTABLE_PROVIDER_IDS = Object.freeze(
  (Object.entries(PROVIDER_CATALOG) as Array<[AdapterProviderId, ProviderCatalogEntry]>)
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
export function getProviderCapabilities(id: string): ProviderCatalogEntry | undefined {
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
