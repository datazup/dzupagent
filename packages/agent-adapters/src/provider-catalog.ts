/**
 * Compatibility facade for the provider catalog's established public surface.
 * Keep implementation concerns in the internal provider-catalog modules.
 */
export {
  PROVIDER_CATALOG,
  type ApprovalSupportTier,
  type MonitorTier,
  type ProviderCapabilities,
  type ProviderCatalogEntry,
  type ProviderToolControlSupport,
  type ToolControlSupportTier,
} from './provider-catalog/catalog.js'
export { assertProviderCatalogEntry } from './provider-catalog/runtime-validation.js'
export {
  HTTP_ROUTABLE_PROVIDER_IDS,
  getDefaultMonitorStatus,
  getMonitorableProviders,
  getProductProviders,
  getProviderCapabilities,
} from './provider-catalog/selectors.js'
