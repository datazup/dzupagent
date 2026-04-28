import {
  validateOutboundUrl,
  validateOutboundUrlSyntax,
  type OutboundUrlSecurityPolicy,
} from '@dzupagent/core'

export interface McpHttpUrlPolicy extends OutboundUrlSecurityPolicy {}

export type McpHttpUrlPolicyResult =
  | { ok: true }
  | { ok: false; reason: string }

function toResult(result: Awaited<ReturnType<typeof validateOutboundUrl>>): McpHttpUrlPolicyResult {
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

export function validateMcpHttpEndpointSync(
  endpoint: string,
  _transport: 'http' | 'sse',
  policy?: McpHttpUrlPolicy,
): McpHttpUrlPolicyResult {
  return toResult(validateOutboundUrlSyntax(endpoint, policy))
}

export async function validateMcpHttpEndpoint(
  endpoint: string,
  _transport: 'http' | 'sse',
  policy?: McpHttpUrlPolicy,
): Promise<McpHttpUrlPolicyResult> {
  return toResult(await validateOutboundUrl(endpoint, policy))
}
