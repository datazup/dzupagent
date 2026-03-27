/**
 * Identity resolution — composable resolver chain for authenticating agents.
 */
import type { ForgeIdentity } from './identity-types.js'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Context provided to identity resolvers for authentication. */
export interface IdentityResolutionContext {
  /** API key, bearer token, or other credential string. */
  token?: string
  /** HTTP headers (lowercased keys). */
  headers?: Record<string, string>
  /** Arbitrary metadata for custom resolvers. */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Resolver interface
// ---------------------------------------------------------------------------

/** Resolves credentials to a ForgeIdentity, or null if not recognized. */
export interface IdentityResolver {
  /** Attempt to resolve an identity from the given context. */
  resolve(context: IdentityResolutionContext): Promise<ForgeIdentity | null>
  /** Verify that an existing identity is still valid. */
  verify(identity: ForgeIdentity): Promise<boolean>
}

// ---------------------------------------------------------------------------
// CompositeIdentityResolver
// ---------------------------------------------------------------------------

/**
 * Tries multiple resolvers in order. The first non-null result wins.
 *
 * For verification, returns true if any resolver confirms the identity.
 */
export class CompositeIdentityResolver implements IdentityResolver {
  private readonly resolvers: IdentityResolver[]

  constructor(resolvers: IdentityResolver[]) {
    this.resolvers = [...resolvers]
  }

  async resolve(context: IdentityResolutionContext): Promise<ForgeIdentity | null> {
    for (const resolver of this.resolvers) {
      const identity = await resolver.resolve(context)
      if (identity !== null) {
        return identity
      }
    }
    return null
  }

  async verify(identity: ForgeIdentity): Promise<boolean> {
    for (const resolver of this.resolvers) {
      const valid = await resolver.verify(identity)
      if (valid) {
        return true
      }
    }
    return false
  }

  /** Add a resolver to the end of the chain. */
  addResolver(resolver: IdentityResolver): void {
    this.resolvers.push(resolver)
  }
}
