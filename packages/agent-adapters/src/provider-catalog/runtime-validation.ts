import type { AdapterCapabilityProfile, AdapterProviderId } from '../types.js'
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from './catalog.js'

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
