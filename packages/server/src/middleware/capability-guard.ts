/**
 * Capability authorization guard for ForgeAgent server.
 *
 * Checks whether the resolved ForgeIdentity has the required capabilities
 * to access a resource. Must be used AFTER identityMiddleware.
 */
import type { MiddlewareHandler } from 'hono'
import { createCapabilityChecker } from '@forgeagent/core'
import { getForgeIdentity } from './identity.js'

/**
 * Hono middleware that checks if the request identity has required capabilities.
 *
 * Accepts a single capability name or an array of capability names.
 * When an array is provided, ALL capabilities must be satisfied.
 * Must be used after identityMiddleware so that forgeIdentity is available.
 */
export function capabilityGuard(
  requiredCapability: string | string[],
): MiddlewareHandler {
  const capabilities = Array.isArray(requiredCapability)
    ? requiredCapability
    : [requiredCapability]

  const checker = createCapabilityChecker()

  return async (c, next) => {
    const identity = getForgeIdentity(c)

    if (!identity) {
      return c.json(
        {
          error: {
            code: 'CAPABILITY_DENIED',
            message: 'No identity available to check capabilities',
          },
        },
        403,
      )
    }

    for (const cap of capabilities) {
      const result = await checker.check({
        identity: {
          id: identity.id,
          uri: identity.uri,
          displayName: identity.displayName,
          capabilities: identity.capabilities,
        },
        requiredCapability: cap,
      })

      if (!result.allowed) {
        return c.json(
          {
            error: {
              code: 'CAPABILITY_DENIED',
              message: result.reason,
              capability: cap,
            },
          },
          403,
        )
      }
    }

    return next()
  }
}
