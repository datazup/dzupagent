export { ProviderAdapterRegistry } from './adapter-registry.js'
export type {
  ProviderAdapterRegistryConfig,
  ProviderAdapterHealthDetail,
  ProviderAdapterRegistryHealthStatus,
} from './adapter-registry.js'
/** @deprecated Use `ProviderAdapterRegistry`. */
export { AdapterRegistry } from './adapter-registry.js'
/** @deprecated Use `ProviderAdapterRegistryConfig`, `ProviderAdapterHealthDetail`, and `ProviderAdapterRegistryHealthStatus`. */
export type {
  AdapterRegistryConfig,
  AdapterHealthDetail,
  DetailedHealthStatus,
} from './adapter-registry.js'

export {
  TagBasedRouter,
  CostOptimizedRouter,
  RoundRobinRouter,
  CompositeRouter,
} from './task-router.js'
export type { WeightedStrategy } from './task-router.js'

export { CapabilityRouter } from './capability-router.js'
export type {
  ProviderCapability,
  ProviderCapabilityTag,
  CapabilityRouterConfig,
} from './capability-router.js'
