import type { FlowHttpCredentialAuth } from '@dzupagent/flow-ast'

const FORBIDDEN_API_KEY_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'host',
  'content-length',
  'connection',
])

/**
 * Inject one already-resolved lease secret into its reviewed HTTP header slot.
 *
 * This host-only helper cannot write URL, query, or body fields, never mutates
 * caller headers, and rejects collisions or header-injection characters.
 */
export function injectFlowHttpCredentialHeader(
  headers: Readonly<Record<string, string>>,
  auth: FlowHttpCredentialAuth,
  credentialMaterial: string,
): Readonly<Record<string, string>> {
  if (
    credentialMaterial.length === 0 ||
    /[\r\n\u0000]/u.test(credentialMaterial)
  ) {
    throw new TypeError('HTTP credential material must be non-empty and header-safe')
  }
  const [headerName, headerValue] = credentialHeader(auth, credentialMaterial)
  const collision = Object.keys(headers).find(
    (existing) => existing.toLowerCase() === headerName.toLowerCase(),
  )
  if (collision !== undefined) {
    throw new Error(`HTTP credential header "${headerName}" already exists`)
  }
  return Object.freeze({ ...headers, [headerName]: headerValue })
}

function credentialHeader(
  auth: FlowHttpCredentialAuth,
  credentialMaterial: string,
): readonly [string, string] {
  switch (auth.scheme) {
    case 'bearer':
      if (auth.headerName !== undefined) {
        throw new TypeError('bearer auth cannot override the Authorization header')
      }
      return ['Authorization', `Bearer ${credentialMaterial}`]
    case 'basic':
      if (auth.headerName !== undefined) {
        throw new TypeError('basic auth cannot override the Authorization header')
      }
      return ['Authorization', `Basic ${Buffer.from(credentialMaterial, 'utf8').toString('base64')}`]
    case 'api-key-header': {
      const headerName = auth.headerName
      if (
        headerName === undefined ||
        !/^[A-Za-z0-9-]+$/u.test(headerName) ||
        FORBIDDEN_API_KEY_HEADERS.has(headerName.toLowerCase())
      ) {
        throw new TypeError('api-key-header requires a reviewed non-reserved headerName')
      }
      return [headerName, credentialMaterial]
    }
  }
}
