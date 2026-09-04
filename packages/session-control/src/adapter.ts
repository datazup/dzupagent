import {
  SESSION_CONTROL_CAPABILITIES,
  type JsonObject,
  type OpaqueReference,
  type Sha256Digest,
  type SessionControlCapability,
  type ValidationIssue,
} from './contracts.js'
import type { CommandEvidence } from './command-ledger.js'
import {
  evaluateCapabilityDeclaration,
  validateCapabilityManifest,
  type SessionControlCapabilityManifest,
} from './capabilities.js'

export interface AdapterInvocation {
  readonly correlationRef: OpaqueReference
  readonly sessionRef?: OpaqueReference
  readonly commandId?: OpaqueReference
  readonly expectedGeneration?: number
  readonly deadline?: string
  readonly idempotencyKey?: Sha256Digest
  readonly payload?: JsonObject
}

export type AdapterOperationStatus =
  | 'accepted'
  | 'provider_waiting'
  | 'applied'
  | 'interaction_required'
  | 'failed'

export interface AdapterOperationResult {
  readonly status: AdapterOperationStatus
  readonly evidence?: CommandEvidence
  readonly interactionRef?: OpaqueReference
  readonly failureCode?: string
}

export type SessionControlAdapterMethod = (
  invocation: AdapterInvocation,
) => Promise<AdapterOperationResult>

export interface SessionControlAdapter {
  readonly manifest: SessionControlCapabilityManifest
  readonly observe?: SessionControlAdapterMethod
  readonly start?: SessionControlAdapterMethod
  readonly sendMessage?: SessionControlAdapterMethod
  readonly steerActiveTurn?: SessionControlAdapterMethod
  readonly respondInteraction?: SessionControlAdapterMethod
  readonly pause?: SessionControlAdapterMethod
  readonly resume?: SessionControlAdapterMethod
  readonly interrupt?: SessionControlAdapterMethod
  readonly fork?: SessionControlAdapterMethod
  readonly tailEvents?: SessionControlAdapterMethod
  readonly lookupAfterRestart?: SessionControlAdapterMethod
  readonly nativeSessionResume?: SessionControlAdapterMethod
}

export const ADAPTER_METHOD_BY_CAPABILITY = {
  observe: 'observe',
  start: 'start',
  send_message: 'sendMessage',
  steer_active_turn: 'steerActiveTurn',
  respond_interaction: 'respondInteraction',
  pause: 'pause',
  resume: 'resume',
  interrupt: 'interrupt',
  fork: 'fork',
  tail_events: 'tailEvents',
  lookup_after_restart: 'lookupAfterRestart',
  native_session_resume: 'nativeSessionResume',
} as const satisfies Record<SessionControlCapability, keyof SessionControlAdapter>

export interface AdapterConformanceIssue extends ValidationIssue {
  readonly capability?: SessionControlCapability
  readonly method?: string
}

export type AdapterConformanceResult =
  | { readonly ok: true; readonly value: SessionControlAdapter }
  | { readonly ok: false; readonly issues: readonly AdapterConformanceIssue[] }

export function validateAdapterConformance(
  adapter: SessionControlAdapter,
): AdapterConformanceResult {
  const manifestResult = validateCapabilityManifest(adapter.manifest)
  if (!manifestResult.ok) return { ok: false, issues: manifestResult.issues }

  const issues: AdapterConformanceIssue[] = []
  for (const capability of SESSION_CONTROL_CAPABILITIES) {
    const declaration = adapter.manifest.capabilities[capability]
    if (declaration.support !== 'native' || declaration.qualification !== 'qualified') continue
    const method = ADAPTER_METHOD_BY_CAPABILITY[capability]
    if (typeof adapter[method] !== 'function') {
      issues.push({
        path: method,
        code: 'declared_method_missing',
        message: 'native qualified capability requires its exact adapter method',
        capability,
        method,
      })
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: adapter }
}

export function isAdapterCapabilityCallable(
  adapter: SessionControlAdapter,
  capability: SessionControlCapability,
): boolean {
  const declaration = adapter.manifest.capabilities[capability]
  const method = ADAPTER_METHOD_BY_CAPABILITY[capability]
  return evaluateCapabilityDeclaration(declaration).callable && typeof adapter[method] === 'function'
}
