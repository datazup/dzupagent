import { validateCapabilityManifest } from './capabilities.js'
import {
  SESSION_CONTROL_SCHEMAS,
  TERMINAL_SESSION_STATUSES,
  type ValidationIssue,
} from './contracts.js'
import { validateSessionControlCommand } from './commands.js'
import { createSessionSnapshot, reduceSessionEvent, validateNormalizedSessionEvent } from './session-reducer.js'
import type {
  CreateSessionSnapshotInput,
  NormalizedSessionEvent,
  SessionSnapshot,
} from './session-types.js'
import { isJsonValue, isOpaqueReference, validateExecutionProfile } from './validation.js'

export interface PortabilityIssue {
  readonly path: string
  readonly code: 'forbidden_key' | 'forbidden_value' | 'non_json_value'
}

export interface PortabilityReport {
  readonly portable: boolean
  readonly issues: readonly PortabilityIssue[]
}

const FORBIDDEN_KEYS = new Set([
  'apitoken',
  'accesstoken',
  'credential',
  'credentials',
  'password',
  'secret',
  'cookie',
  'authorization',
  'apikey',
  'privatekey',
  'nativesessionid',
  'nativethreadid',
  'providersessionid',
  'providerthreadid',
  'transcript',
  'rawtranscript',
  'rawevent',
  'rawsdk',
  'providerobject',
  'providerhandle',
  'sdkobject',
  'sdkhandle',
  'hostpath',
  'hostname',
  'terminalhandle',
  'terminalinput',
])
const FORBIDDEN_VENDOR = /\b(?:codex|claude|gemini|qwen|goose|crush|datazup)\b/i
const HOST_PATH = /^(?:\/|[A-Za-z]:\\|~\/)/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function scanPortableSessionControlValue(value: unknown): PortabilityReport {
  const issues: PortabilityIssue[] = []
  if (!isJsonValue(value)) {
    return { portable: false, issues: [{ path: '$', code: 'non_json_value' }] }
  }

  function visit(current: unknown, path: string): void {
    if (typeof current === 'string') {
      if (FORBIDDEN_VENDOR.test(current) || HOST_PATH.test(current)) {
        issues.push({ path, code: 'forbidden_value' })
      }
      return
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (!isRecord(current)) return
    for (const [key, entry] of Object.entries(current)) {
      const childPath = `${path}.${key}`
      if (FORBIDDEN_KEYS.has(key.replaceAll('_', '').replaceAll('-', '').toLowerCase())) {
        issues.push({ path: childPath, code: 'forbidden_key' })
      }
      visit(entry, childPath)
    }
  }

  visit(value, '$')
  return { portable: issues.length === 0, issues }
}

export interface ConformanceSummary {
  readonly qualificationScope: 'provider_free'
  readonly profiles: number
  readonly commands: number
  readonly events: number
  readonly terminalStatus: string
}

export type ConformanceResult =
  | { readonly ok: true; readonly summary: ConformanceSummary }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message }
}

export function validateSessionControlConformanceFixture(input: unknown): ConformanceResult {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('$', 'invalid_type', 'fixture must be an object')] }
  }
  const portability = scanPortableSessionControlValue(input)
  if (!portability.portable) {
    return {
      ok: false,
      issues: portability.issues.map((entry) => issue(entry.path, entry.code, 'fixture is not portable')),
    }
  }
  if (
    input.schema !== SESSION_CONTROL_SCHEMAS.conformanceFixture ||
    !isOpaqueReference(input.fixtureRef) ||
    input.qualificationScope !== 'provider_free'
  ) {
    return { ok: false, issues: [issue('$', 'invalid_fixture_header', 'invalid fixture header')] }
  }
  if (!Array.isArray(input.profiles) || input.profiles.length === 0) {
    return { ok: false, issues: [issue('profiles', 'profiles_required', 'profiles are required')] }
  }
  const profiles = input.profiles.map(validateExecutionProfile)
  const invalidProfile = profiles.findIndex((result) => !result.ok)
  if (invalidProfile >= 0) {
    return { ok: false, issues: [issue(`profiles[${invalidProfile}]`, 'invalid_profile', 'invalid profile')] }
  }
  const manifest = validateCapabilityManifest(input.manifest)
  if (!manifest.ok) return { ok: false, issues: manifest.issues }
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    return { ok: false, issues: [issue('commands', 'commands_required', 'commands are required')] }
  }
  for (let index = 0; index < input.commands.length; index += 1) {
    const result = validateSessionControlCommand(input.commands[index])
    if (!result.ok) return { ok: false, issues: result.issues }
  }
  if (!isRecord(input.session)) {
    return { ok: false, issues: [issue('session', 'invalid_session', 'session seed is required')] }
  }
  const profileIndex = input.session.profileIndex
  if (!Number.isSafeInteger(profileIndex) || Number(profileIndex) < 0 || Number(profileIndex) >= profiles.length) {
    return { ok: false, issues: [issue('session.profileIndex', 'invalid_profile_index', 'invalid profile index')] }
  }
  const selectedProfile = profiles[Number(profileIndex)]
  if (selectedProfile === undefined || !selectedProfile.ok) {
    return { ok: false, issues: [issue('session.profileIndex', 'invalid_profile_index', 'invalid profile index')] }
  }
  const created = createSessionSnapshot({
    sessionRef: input.session.sessionRef,
    profile: selectedProfile.value,
    origin: input.session.origin,
    status: input.session.status,
    recordedAt: input.session.recordedAt,
  } as CreateSessionSnapshotInput)
  if (!created.ok) return { ok: false, issues: [created.issue] }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, issues: [issue('events', 'events_required', 'events are required')] }
  }

  let snapshot: SessionSnapshot = created.snapshot
  for (let index = 0; index < input.events.length; index += 1) {
    const validated = validateNormalizedSessionEvent(input.events[index])
    if (!validated.ok) return { ok: false, issues: validated.issues }
    const reduced = reduceSessionEvent(snapshot, validated.value as NormalizedSessionEvent)
    if (!reduced.ok) return { ok: false, issues: [reduced.issue] }
    snapshot = reduced.snapshot
  }
  if (!TERMINAL_SESSION_STATUSES.includes(snapshot.status as never)) {
    return {
      ok: false,
      issues: [issue('events', 'terminal_outcome_required', 'trace must end in a terminal state')],
    }
  }

  return {
    ok: true,
    summary: {
      qualificationScope: 'provider_free',
      profiles: profiles.length,
      commands: input.commands.length,
      events: input.events.length,
      terminalStatus: snapshot.status,
    },
  }
}
