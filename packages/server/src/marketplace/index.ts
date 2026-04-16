/**
 * Marketplace module — agent catalog store and Drizzle implementation.
 */
export type {
  CatalogEntry,
  CatalogEntryCreate,
  CatalogEntryPatch,
  CatalogSearchQuery,
  CatalogSearchResult,
  CatalogStore,
} from './catalog-store.js'
export {
  InMemoryCatalogStore,
  CatalogNotFoundError,
  CatalogSlugConflictError,
} from './catalog-store.js'
export { DrizzleCatalogStore } from './drizzle-catalog-store.js'
