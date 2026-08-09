import type { AdapterProviderId } from '../types.js'
import type { CatalogEntry, EventFidelity } from '@dzupagent/adapter-types/monitoring/installation'

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
