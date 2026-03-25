/**
 * Identity module — barrel exports.
 */

// --- Types ---
export { toIdentityRef } from './identity-types.js'
export type {
  ForgeIdentity,
  ForgeCredential,
  ForgeCapability,
  ForgeIdentityRef,
  CredentialType,
} from './identity-types.js'

// --- Schemas ---
export {
  ForgeIdentitySchema,
  ForgeCapabilitySchema,
  ForgeCredentialSchema,
  ForgeIdentityRefSchema,
} from './identity-schemas.js'

// --- URI ---
export {
  parseForgeUri,
  buildForgeUri,
  isForgeUri,
  toAgentUri,
  fromAgentUri,
  createUriResolver,
  ForgeUriSchema,
} from './forge-uri.js'
export type {
  ParsedForgeUri,
  UriResolver,
  UriResolverStrategy,
  UriResolverConfig,
} from './forge-uri.js'

// --- Signing ---
export type {
  SigningKeyPair,
  SigningKeyStatus,
  SignedDocument,
  SignedAgentCard,
  KeyStore,
} from './signing-types.js'

export { createKeyManager, InMemoryKeyStore } from './key-manager.js'
export type { KeyManagerConfig, KeyManager } from './key-manager.js'

// --- Identity Resolution ---
export { CompositeIdentityResolver } from './identity-resolver.js'
export type {
  IdentityResolutionContext,
  IdentityResolver,
} from './identity-resolver.js'

export { createAPIKeyResolver, hashAPIKey } from './api-key-resolver.js'
export type {
  APIKeyRecord,
  APIKeyResolverConfig,
  APIKeyIdentityResolver,
} from './api-key-resolver.js'

// --- Delegation ---
export type {
  DelegationToken,
  DelegationConstraint,
  DelegationChain,
  DelegationTokenStore,
} from './delegation-types.js'
export { InMemoryDelegationTokenStore } from './delegation-store.js'
export { DelegationManager } from './delegation-manager.js'
export type {
  DelegationManagerConfig,
  IssueDelegationParams,
} from './delegation-manager.js'

// --- Capability Checker ---
export { createCapabilityChecker } from './capability-checker.js'
export type {
  CapabilityCheckResult,
  CapabilityCheckerConfig,
  CapabilityCheckParams,
  CapabilityChecker,
} from './capability-checker.js'

// --- Trust Scoring ---
export { createTrustScorer, InMemoryTrustScoreStore } from './trust-scorer.js'
export type {
  TrustSignals,
  TrustScoreBreakdown,
  TrustScorerConfig,
  TrustScoreStore,
  TrustScorer,
} from './trust-scorer.js'
