export interface OutboundUrlSecurityPolicy {
  allowedHosts?: string[]
  blockedHosts?: string[]
  allowPrivateNetwork?: boolean
  allowHttp?: boolean
}

export interface OutboundUrlValidationResult {
  ok: boolean
  reason?: string
  parsedUrl?: URL
}

export interface FetchWithOutboundUrlPolicyOptions {
  policy?: OutboundUrlSecurityPolicy | undefined
}

export function validateOutboundUrlSyntax(
  url: string,
  policy?: OutboundUrlSecurityPolicy,
): OutboundUrlValidationResult {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }

  if (parsedUrl.protocol === 'http:' && !policy?.allowHttp) {
    return { ok: false, reason: 'http-not-allowed', parsedUrl }
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { ok: false, reason: 'unsupported-protocol', parsedUrl }
  }

  const host = parsedUrl.hostname.toLowerCase()
  if (policy?.blockedHosts?.some((blocked) => host === blocked.toLowerCase())) {
    return { ok: false, reason: 'blocked-host', parsedUrl }
  }
  if (policy?.allowedHosts && !policy.allowedHosts.some((allowed) => host === allowed.toLowerCase())) {
    return { ok: false, reason: 'host-not-allowlisted', parsedUrl }
  }
  if (!policy?.allowPrivateNetwork && isPrivateHost(host)) {
    return { ok: false, reason: 'private-network-host', parsedUrl }
  }

  return { ok: true, parsedUrl }
}

export async function fetchWithOutboundUrlPolicy(
  url: string,
  init?: RequestInit,
  options?: FetchWithOutboundUrlPolicyOptions,
): Promise<Response> {
  const validation = validateOutboundUrlSyntax(url, options?.policy)
  if (!validation.ok) {
    throw new Error(`Outbound URL blocked: ${validation.reason ?? 'unknown'}`)
  }
  return await fetch(url, init)
}

function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === '::1'
  )
}

export type PolicyEffect = 'allow' | 'deny'

export interface PolicyRule {
  id: string
  effect: PolicyEffect
  actions: string[]
  resources?: string[]
}

export interface PolicySet {
  id: string
  name: string
  version: number
  active: boolean
  rules: PolicyRule[]
}

export interface PolicyContext {
  principal: { type: string; id: string }
  action: string
  resource?: string
  environment?: Record<string, unknown>
}

export interface PolicyDecision {
  effect: PolicyEffect
  reason?: string
}

export class PolicyEvaluator {
  evaluate(policySet: PolicySet, context: PolicyContext): PolicyDecision {
    for (const rule of policySet.rules ?? []) {
      if (!matchesAny(rule.actions, context.action)) continue
      if (rule.resources && context.resource && !matchesAny(rule.resources, context.resource)) continue
      return { effect: rule.effect, reason: rule.id }
    }
    return { effect: 'allow' }
  }
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => pattern === '*' || pattern === value || (
    pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1))
  ))
}

export interface RiskClassification {
  tier: 'safe' | 'low' | 'medium' | 'high' | 'require-approval'
}

export interface RiskClassifier {
  classify(toolName: string, metadata?: Record<string, unknown>): RiskClassification
}

export interface RiskClassifierConfig {
  requireApprovalTools?: string[]
  highRiskTools?: string[]
}

export function createRiskClassifier(config: Partial<RiskClassifierConfig> = {}): RiskClassifier {
  const requireApproval = new Set(config.requireApprovalTools ?? ['delete', 'rm', 'write', 'execute'])
  const highRisk = new Set(config.highRiskTools ?? ['network', 'shell'])
  return {
    classify(toolName: string): RiskClassification {
      const normalized = toolName.toLowerCase()
      if ([...requireApproval].some((entry) => normalized.includes(entry))) {
        return { tier: 'require-approval' }
      }
      if ([...highRisk].some((entry) => normalized.includes(entry))) {
        return { tier: 'high' }
      }
      return { tier: 'safe' }
    },
  }
}
