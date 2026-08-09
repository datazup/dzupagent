import type { AdapterMonitorStatus, AdapterProviderId } from '../types.js'
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from './catalog.js'

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
