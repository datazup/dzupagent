import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import {
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  type ProviderSessionBackendKind,
  type ProviderSessionCapability,
  type ProviderSessionCapabilityDescriptor,
  type ProviderSessionCapabilityMap,
} from '@dzupagent/runtime-contracts/provider-session'

import {
  createNodeProbeRunner,
  parseVersion,
  type ProbeFailureClassification,
  type ProbeResult,
  type ResolvedProbeExecutable,
  type SafeProbeCommandRunner,
} from '../introspection/index.js'

export type CodexGoalCapabilityBackendKind = Extract<
  ProviderSessionBackendKind,
  'app-server' | 'cli' | 'sdk'
>

export type CodexGoalCapabilityObservationFailure =
  | 'version-observation-failed'
  | 'schema-help-observation-failed'
  | 'protocol-generation-failed'
  | 'protocol-observation-timeout'
  | 'protocol-observation-output-limit'
  | 'protocol-observation-process-failure'
  | 'protocol-schema-file-limit'
  | 'protocol-schema-invalid'

export interface CodexGoalProtocolObservation {
  /** Codex version for which the schema generator ran. */
  readonly generatedForVersion: string
  /** Sanitized logical reference; never a host filesystem path. */
  readonly schemaRef: string
  /** Exact digest over sorted relative path, NUL, and raw file bytes. */
  readonly schemaDigest: string
  /** Runtime-local parsed documents. These are never copied into the descriptor. */
  readonly documents: Readonly<Record<string, unknown>>
}

/** Phase-3 name for the complete App Server schema observation. */
export type CodexAppServerProtocolObservation = CodexGoalProtocolObservation

export interface CodexGoalCapabilityMaterializationInput {
  readonly backendKind: CodexGoalCapabilityBackendKind
  readonly installedVersion?: string | undefined
  /** SHA-256 of the observed executable bytes; no host path enters the descriptor. */
  readonly executableArtifactDigest?: string | undefined
  readonly protocol?: CodexGoalProtocolObservation | undefined
  readonly observedAt: string
  readonly providerId?: string | undefined
  readonly expectedVersion?: string | undefined
  readonly expectedSchemaDigest?: string | undefined
  readonly observationFailure?: CodexGoalCapabilityObservationFailure | undefined
}

/** Phase-3 name retained alongside the phase-2 goal-only API aliases. */
export type CodexAppServerCapabilityMaterializationInput =
  CodexGoalCapabilityMaterializationInput

export interface ObserveInstalledCodexGoalCapabilityOptions {
  readonly executable: ResolvedProbeExecutable
  /** Absolute, repository-owned working directory for provider-free probing. */
  readonly cwd: string
  readonly sourceEnv?: Readonly<Record<string, string | undefined>> | undefined
  readonly observedAt?: string | undefined
  readonly expectedVersion?: string | undefined
  readonly expectedSchemaDigest?: string | undefined
  /** Tightens the framework probe ceiling; never expands it. */
  readonly timeoutMs?: number | undefined
}

export type ObserveInstalledCodexAppServerCapabilityOptions =
  ObserveInstalledCodexGoalCapabilityOptions

interface SchemaCorpus {
  readonly documents: Readonly<Record<string, unknown>>
  readonly digest: string
  readonly fileCount: number
}

interface CorpusFile {
  readonly path: string
  readonly relativePath: string
  readonly size: number
}

const PROVIDER_ID = 'codex'
const MAX_SCHEMA_FILES = 512
const MAX_SCHEMA_FILE_BYTES = 1_000_000
const MAX_SCHEMA_TOTAL_BYTES = 8_000_000
const MAX_SCHEMA_DEPTH = 8
const DEFAULT_OBSERVATION_TIMEOUT_MS = 10_000
const INTERACTION_REQUESTS = [
  ['item/commandExecution/requestApproval', 'CommandExecutionRequestApprovalParams'],
  ['item/fileChange/requestApproval', 'FileChangeRequestApprovalParams'],
  ['item/tool/requestUserInput', 'ToolRequestUserInputParams'],
] as const
const GOAL_METHODS = [
  ['thread/goal/get', 'ThreadGoalGetParams'],
  ['thread/goal/set', 'ThreadGoalSetParams'],
  ['thread/goal/clear', 'ThreadGoalClearParams'],
] as const
const GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const
const REQUIRED_DOCUMENTS = [
  'ClientRequest.json',
  'ClientNotification.json',
  'ServerNotification.json',
  'ServerRequest.json',
  'CommandExecutionRequestApprovalParams.json',
  'FileChangeRequestApprovalParams.json',
  'ToolRequestUserInputParams.json',
  'v1/InitializeParams.json',
  'v1/InitializeResponse.json',
  'v2/ThreadStartParams.json',
  'v2/ThreadStartResponse.json',
  'v2/ThreadResumeParams.json',
  'v2/ThreadResumeResponse.json',
  'v2/ThreadStartedNotification.json',
  'v2/TurnStartParams.json',
  'v2/TurnStartResponse.json',
  'v2/TurnInterruptParams.json',
  'v2/TurnInterruptResponse.json',
  'v2/TurnStartedNotification.json',
  'v2/TurnCompletedNotification.json',
  'v2/AgentMessageDeltaNotification.json',
  'v2/ThreadTokenUsageUpdatedNotification.json',
  'v2/ThreadGoalGetParams.json',
  'v2/ThreadGoalGetResponse.json',
  'v2/ThreadGoalSetParams.json',
  'v2/ThreadGoalSetResponse.json',
  'v2/ThreadGoalClearParams.json',
  'v2/ThreadGoalClearResponse.json',
] as const

/**
 * Converts one runtime-local Codex schema observation into the provider-neutral
 * provider-session descriptor. It never creates an attempt binding or grants
 * effect, retry, fallback, repository, or completion authority.
 */
export function materializeCodexAppServerCapabilityDescriptor(
  input: CodexAppServerCapabilityMaterializationInput,
): ProviderSessionCapabilityDescriptor {
  assertObservationIdentity(input)

  const protocol = input.protocol
  let sharedReason: string | undefined
  if (input.backendKind !== 'app-server') {
    sharedReason = 'app-server-capabilities-require-app-server-backend'
  } else if (input.observationFailure) {
    sharedReason = input.observationFailure
  } else if (!input.installedVersion) {
    sharedReason = 'installed-version-missing'
  } else if (input.executableArtifactDigest === undefined) {
    sharedReason = 'executable-artifact-digest-missing'
  } else if (!validSchemaDigest(input.executableArtifactDigest)) {
    sharedReason = 'executable-artifact-digest-invalid'
  } else if (!protocol) {
    sharedReason = 'generated-protocol-schema-missing'
  } else if (!validSchemaDigest(protocol.schemaDigest)) {
    sharedReason = 'protocol-schema-digest-invalid'
  } else if (!validSchemaReference(protocol.schemaRef)) {
    sharedReason = 'protocol-schema-reference-invalid'
  } else if (protocol.generatedForVersion !== input.installedVersion) {
    sharedReason = 'installed-version-schema-version-drift'
  } else if (
    input.expectedVersion !== undefined
    && input.expectedVersion !== input.installedVersion
  ) {
    sharedReason = 'expected-installed-version-drift'
  } else if (
    input.expectedSchemaDigest !== undefined
    && normalizeDigest(input.expectedSchemaDigest) !== protocol.schemaDigest
  ) {
    sharedReason = 'expected-protocol-schema-drift'
  }

  const capabilityReasons = sharedReason
    ? sharedCapabilityReasons(sharedReason)
    : inspectAppServerProtocol(protocol?.documents ?? {})

  const providerId = input.providerId ?? PROVIDER_ID
  const digest = protocol?.schemaDigest
  const artifactDigest = input.executableArtifactDigest
  const version = input.installedVersion
  const descriptorSeed = [
    providerId,
    input.backendKind,
    version ?? '',
    digest ?? '',
    artifactDigest ?? '',
  ].join('\0')
  const descriptorDigest = createHash('sha256').update(descriptorSeed).digest('hex')
  const backendId = [
    `codex-${input.backendKind}`,
    version ?? 'unknown',
    digest?.slice('sha256:'.length, 'sha256:'.length + 16) ?? 'unqualified',
    artifactDigest?.slice('sha256:'.length, 'sha256:'.length + 16) ?? 'unqualified',
  ].join('@')

  return {
    schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
    descriptorId: `provider-session-descriptor/codex/${descriptorDigest.slice(0, 32)}`,
    providerId,
    backend: {
      id: backendId,
      kind: input.backendKind,
      ...(version ? { version } : {}),
      ...(protocol && validSchemaReference(protocol.schemaRef)
        ? { protocolSchemaRef: protocol.schemaRef }
        : {}),
      ...(digest && validSchemaDigest(digest)
        ? { protocolSchemaDigest: digest }
        : {}),
      ...(artifactDigest && validSchemaDigest(artifactDigest)
        ? { artifactDigest }
        : {}),
    },
    capabilities: buildCapabilityMap(capabilityReasons),
    observedAt: input.observedAt,
    ...(digest && validSchemaDigest(digest)
      ? { evidenceRef: `codex-app-server-schema/${digest}` }
      : {}),
  }
}

/** @deprecated Use materializeCodexAppServerCapabilityDescriptor. */
export function materializeCodexGoalCapabilityDescriptor(
  input: CodexGoalCapabilityMaterializationInput,
): ProviderSessionCapabilityDescriptor {
  return materializeCodexAppServerCapabilityDescriptor(input)
}

/**
 * Observes the installed Codex CLI without authenticating or starting a
 * thread/turn. The generated schema exists only inside a unique temporary
 * directory and must be removed successfully before a descriptor is returned.
 */
export async function observeInstalledCodexAppServerCapability(
  options: ObserveInstalledCodexAppServerCapabilityOptions,
): Promise<ProviderSessionCapabilityDescriptor> {
  return observeInstalledCodexAppServerCapabilityWithRunner(options, (managedHome) =>
    createNodeProbeRunner({
      executables: [options.executable],
      managedHome,
      cwd: options.cwd,
      sourceEnv: options.sourceEnv
        ? { ...options.sourceEnv }
        : undefined,
      limits: {
        maxDurationMs: finiteTimeout(options.timeoutMs),
      },
    }))
}

/** @deprecated Use observeInstalledCodexAppServerCapability. */
export async function observeInstalledCodexGoalCapability(
  options: ObserveInstalledCodexGoalCapabilityOptions,
): Promise<ProviderSessionCapabilityDescriptor> {
  return observeInstalledCodexAppServerCapability(options)
}

/** @internal Test port. Deliberately absent from the package subpath export. */
export async function observeInstalledCodexGoalCapabilityForTesting(
  options: ObserveInstalledCodexGoalCapabilityOptions,
  createRunner: (managedHome: string) => SafeProbeCommandRunner,
): Promise<ProviderSessionCapabilityDescriptor> {
  return observeInstalledCodexAppServerCapabilityWithRunner(options, createRunner)
}

export async function observeInstalledCodexAppServerCapabilityForTesting(
  options: ObserveInstalledCodexAppServerCapabilityOptions,
  createRunner: (managedHome: string) => SafeProbeCommandRunner,
): Promise<ProviderSessionCapabilityDescriptor> {
  return observeInstalledCodexAppServerCapabilityWithRunner(options, createRunner)
}

async function observeInstalledCodexAppServerCapabilityWithRunner(
  options: ObserveInstalledCodexAppServerCapabilityOptions,
  createRunner: (managedHome: string) => SafeProbeCommandRunner,
): Promise<ProviderSessionCapabilityDescriptor> {
  const observedAt = options.observedAt ?? new Date().toISOString()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dzupagent-codex-goal-capability-'))
  const managedHome = join(temporaryRoot, 'home')
  const schemaDirectory = join(temporaryRoot, 'schema')
  let descriptor: ProviderSessionCapabilityDescriptor | undefined
  let cleanupError: unknown

  try {
    await mkdir(managedHome, { recursive: false, mode: 0o700 })
    await mkdir(schemaDirectory, { recursive: false, mode: 0o700 })
    const runProbe = createRunner(managedHome)
    const timeoutMs = finiteTimeout(options.timeoutMs)

    const versionProbe = await runProbe({
      command: 'codex',
      args: ['--version'],
      timeoutMs,
    })
    const installedVersion = successful(versionProbe)
      ? parseVersion(versionProbe.stdout)
      : null
    if (!installedVersion) {
      descriptor = materializeFailure(
        options,
        observedAt,
        failureReason(versionProbe, 'version-observation-failed'),
      )
      return descriptor
    }

    const helpProbe = await runProbe({
      command: 'codex',
      args: ['app-server', 'generate-json-schema', '--help'],
      timeoutMs,
    })
    if (!successful(helpProbe)) {
      descriptor = materializeFailure(
        options,
        observedAt,
        failureReason(helpProbe, 'schema-help-observation-failed'),
        installedVersion,
      )
      return descriptor
    }

    const experimental = helpProbe.stdout.includes('--experimental')
    const generationArgs = ['app-server', 'generate-json-schema']
    if (experimental) generationArgs.push('--experimental')
    generationArgs.push('--out', schemaDirectory)
    const generationProbe = await runProbe({
      command: 'codex',
      args: generationArgs,
      timeoutMs,
    })
    if (!successful(generationProbe)) {
      descriptor = materializeFailure(
        options,
        observedAt,
        failureReason(generationProbe, 'protocol-generation-failed'),
        installedVersion,
      )
      return descriptor
    }

    let corpus: SchemaCorpus
    try {
      corpus = await readSchemaCorpus(schemaDirectory)
    } catch (error) {
      const reason = error instanceof SchemaCorpusError
        ? error.reason
        : 'protocol-schema-invalid'
      descriptor = materializeFailure(
        options,
        observedAt,
        reason,
        installedVersion,
      )
      return descriptor
    }

    descriptor = materializeCodexAppServerCapabilityDescriptor({
      backendKind: 'app-server',
      installedVersion,
      executableArtifactDigest: options.executable.artifactDigest,
      observedAt,
      expectedVersion: options.expectedVersion,
      expectedSchemaDigest: options.expectedSchemaDigest,
      protocol: {
        generatedForVersion: installedVersion,
        schemaRef: `codex-app-server://generated-json-schema/${installedVersion}`
          + `?experimental=${experimental ? '1' : '0'}`
          + `&files=${corpus.fileCount}`,
        schemaDigest: corpus.digest,
        documents: corpus.documents,
      },
    })
    return descriptor
  } finally {
    try {
      await rm(temporaryRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupError = error
    }
    if (cleanupError) {
      throw new Error('Codex goal capability observation cleanup failed')
    }
  }
}

function materializeFailure(
  options: ObserveInstalledCodexGoalCapabilityOptions,
  observedAt: string,
  observationFailure: CodexGoalCapabilityObservationFailure,
  installedVersion?: string,
): ProviderSessionCapabilityDescriptor {
  return materializeCodexGoalCapabilityDescriptor({
    backendKind: 'app-server',
    installedVersion,
    executableArtifactDigest: options.executable.artifactDigest,
    observedAt,
    expectedVersion: options.expectedVersion,
    expectedSchemaDigest: options.expectedSchemaDigest,
    observationFailure,
  })
}

type CapabilityReasonMap = Partial<Readonly<Record<ProviderSessionCapability, string | undefined>>>

const OBSERVED_APP_SERVER_CAPABILITIES = new Set<ProviderSessionCapability>([
  'execute',
  'stream',
  'resume',
  'cancel',
  'interaction',
  'usage',
  'interrupt-turn',
  'goal-control',
])

function sharedCapabilityReasons(reason: string): CapabilityReasonMap {
  return Object.fromEntries(
    [...OBSERVED_APP_SERVER_CAPABILITIES].map((capability) => [capability, reason]),
  )
}

function buildCapabilityMap(reasons: CapabilityReasonMap): ProviderSessionCapabilityMap {
  return Object.fromEntries(PROVIDER_SESSION_CAPABILITIES.map((capability) => [
    capability,
    OBSERVED_APP_SERVER_CAPABILITIES.has(capability) && reasons[capability] === undefined
      ? { status: 'native', emulation: 'forbidden' }
      : {
          status: 'unsupported',
          emulation: 'forbidden',
          reason: reasons[capability]
            ?? 'capability-not-observed-by-app-server-probe',
        },
  ])) as ProviderSessionCapabilityMap
}

function inspectAppServerProtocol(
  documents: Readonly<Record<string, unknown>>,
): CapabilityReasonMap {
  const handshakeReason = inspectHandshakeProtocol(documents)
  const cancelReason = handshakeReason ?? inspectCancelProtocol(documents)
  const interactionShapeReason = handshakeReason ?? inspectInteractionProtocol(documents)
  return {
    execute: handshakeReason ?? inspectExecuteProtocol(documents),
    stream: handshakeReason ?? inspectStreamProtocol(documents),
    resume: handshakeReason ?? inspectResumeProtocol(documents),
    cancel: cancelReason,
    interaction: interactionShapeReason ?? 'interaction-resolution-not-qualified',
    usage: handshakeReason ?? inspectUsageProtocol(documents),
    'interrupt-turn': cancelReason,
    'goal-control': handshakeReason ?? inspectGoalProtocol(documents),
  }
}

function inspectHandshakeProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'ClientNotification.json',
    'v1/InitializeParams.json',
    'v1/InitializeResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasRequestMethod(record(documents['ClientRequest.json']), 'initialize', 'InitializeParams')) {
    return 'protocol-method-missing:initialize'
  }
  if (!hasNotificationMethod(record(documents['ClientNotification.json']), 'initialized')) {
    return 'protocol-method-missing:initialized'
  }
  if (!validInitializeParams(record(documents['v1/InitializeParams.json']))) {
    return 'protocol-shape-mismatch:InitializeParams'
  }
  if (!validInitializeResponse(record(documents['v1/InitializeResponse.json']))) {
    return 'protocol-shape-mismatch:InitializeResponse'
  }
  return undefined
}

function inspectExecuteProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/ThreadStartParams.json',
    'v2/ThreadStartResponse.json',
    'v2/TurnStartParams.json',
    'v2/TurnStartResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  const clientRequest = record(documents['ClientRequest.json'])
  for (const [method, paramsName] of [
    ['thread/start', 'ThreadStartParams'],
    ['turn/start', 'TurnStartParams'],
  ] as const) {
    if (!hasRequestMethod(clientRequest, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }
  if (!validThreadStartParams(record(documents['v2/ThreadStartParams.json']))) {
    return 'protocol-shape-mismatch:ThreadStartParams'
  }
  if (!validThreadResponse(record(documents['v2/ThreadStartResponse.json']))) {
    return 'protocol-shape-mismatch:ThreadStartResponse'
  }
  if (!validTurnStartParams(record(documents['v2/TurnStartParams.json']))) {
    return 'protocol-shape-mismatch:TurnStartParams'
  }
  if (!validTurnResponse(record(documents['v2/TurnStartResponse.json']))) {
    return 'protocol-shape-mismatch:TurnStartResponse'
  }
  return undefined
}

function inspectResumeProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/ThreadResumeParams.json',
    'v2/ThreadResumeResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasRequestMethod(
    record(documents['ClientRequest.json']),
    'thread/resume',
    'ThreadResumeParams',
  )) {
    return 'protocol-method-missing:thread/resume'
  }
  if (!validThreadResumeParams(record(documents['v2/ThreadResumeParams.json']))) {
    return 'protocol-shape-mismatch:ThreadResumeParams'
  }
  if (!validThreadResponse(record(documents['v2/ThreadResumeResponse.json']))) {
    return 'protocol-shape-mismatch:ThreadResumeResponse'
  }
  return undefined
}

function inspectCancelProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/TurnInterruptParams.json',
    'v2/TurnInterruptResponse.json',
    'v2/TurnCompletedNotification.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasRequestMethod(
    record(documents['ClientRequest.json']),
    'turn/interrupt',
    'TurnInterruptParams',
  )) {
    return 'protocol-method-missing:turn/interrupt'
  }
  if (!validTurnInterruptParams(record(documents['v2/TurnInterruptParams.json']))) {
    return 'protocol-shape-mismatch:TurnInterruptParams'
  }
  if (!validEmptyObjectResponse(record(documents['v2/TurnInterruptResponse.json']))) {
    return 'protocol-shape-mismatch:TurnInterruptResponse'
  }
  if (!validTurnNotification(record(documents['v2/TurnCompletedNotification.json']))) {
    return 'protocol-shape-mismatch:TurnCompletedNotification'
  }
  return undefined
}

function inspectStreamProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ServerNotification.json',
    'v2/ThreadStartedNotification.json',
    'v2/TurnStartedNotification.json',
    'v2/AgentMessageDeltaNotification.json',
    'v2/TurnCompletedNotification.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  const serverNotification = record(documents['ServerNotification.json'])
  for (const [method, paramsName] of [
    ['thread/started', 'ThreadStartedNotification'],
    ['turn/started', 'TurnStartedNotification'],
    ['item/agentMessage/delta', 'AgentMessageDeltaNotification'],
    ['turn/completed', 'TurnCompletedNotification'],
  ] as const) {
    if (!hasNotificationMethod(serverNotification, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }
  if (!validThreadStartedNotification(record(documents['v2/ThreadStartedNotification.json']))) {
    return 'protocol-shape-mismatch:ThreadStartedNotification'
  }
  if (!validTurnNotification(record(documents['v2/TurnStartedNotification.json']))) {
    return 'protocol-shape-mismatch:TurnStartedNotification'
  }
  if (!validAgentMessageDelta(record(documents['v2/AgentMessageDeltaNotification.json']))) {
    return 'protocol-shape-mismatch:AgentMessageDeltaNotification'
  }
  if (!validTurnNotification(record(documents['v2/TurnCompletedNotification.json']))) {
    return 'protocol-shape-mismatch:TurnCompletedNotification'
  }
  return undefined
}

function inspectUsageProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ServerNotification.json',
    'v2/ThreadTokenUsageUpdatedNotification.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasNotificationMethod(
    record(documents['ServerNotification.json']),
    'thread/tokenUsage/updated',
    'ThreadTokenUsageUpdatedNotification',
  )) {
    return 'protocol-method-missing:thread/tokenUsage/updated'
  }
  if (!validTokenUsageNotification(
    record(documents['v2/ThreadTokenUsageUpdatedNotification.json']),
  )) {
    return 'protocol-shape-mismatch:ThreadTokenUsageUpdatedNotification'
  }
  return undefined
}

function inspectInteractionProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ServerRequest.json',
    'CommandExecutionRequestApprovalParams.json',
    'FileChangeRequestApprovalParams.json',
    'ToolRequestUserInputParams.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  const serverRequest = record(documents['ServerRequest.json'])
  for (const [method, paramsName] of INTERACTION_REQUESTS) {
    if (!hasRequestMethod(serverRequest, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }
  if (!validApprovalParams(
    record(documents['CommandExecutionRequestApprovalParams.json']),
  )) {
    return 'protocol-shape-mismatch:CommandExecutionRequestApprovalParams'
  }
  if (!validApprovalParams(record(documents['FileChangeRequestApprovalParams.json']))) {
    return 'protocol-shape-mismatch:FileChangeRequestApprovalParams'
  }
  if (!validToolRequestUserInputParams(record(documents['ToolRequestUserInputParams.json']))) {
    return 'protocol-shape-mismatch:ToolRequestUserInputParams'
  }
  return undefined
}

function inspectGoalProtocol(documents: Readonly<Record<string, unknown>>): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/ThreadGoalGetParams.json',
    'v2/ThreadGoalGetResponse.json',
    'v2/ThreadGoalSetParams.json',
    'v2/ThreadGoalSetResponse.json',
    'v2/ThreadGoalClearParams.json',
    'v2/ThreadGoalClearResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }

  const clientRequest = record(documents['ClientRequest.json'])
  for (const [method, paramsName] of GOAL_METHODS) {
    if (!hasRequestMethod(clientRequest, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }

  if (!validThreadIdParams(record(documents['v2/ThreadGoalGetParams.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalGetParams'
  }
  if (!validGoalSetParams(record(documents['v2/ThreadGoalSetParams.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalSetParams'
  }
  if (!validThreadIdParams(record(documents['v2/ThreadGoalClearParams.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalClearParams'
  }
  if (!validGoalResponse(record(documents['v2/ThreadGoalGetResponse.json']), true)) {
    return 'protocol-shape-mismatch:ThreadGoalGetResponse'
  }
  if (!validGoalResponse(record(documents['v2/ThreadGoalSetResponse.json']), false)) {
    return 'protocol-shape-mismatch:ThreadGoalSetResponse'
  }
  if (!validClearResponse(record(documents['v2/ThreadGoalClearResponse.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalClearResponse'
  }
  return undefined
}

function hasRequestMethod(
  schema: Record<string, unknown>,
  method: string,
  paramsName: string,
): boolean {
  const branches = array(schema['oneOf'])
  return branches.some((candidate) => {
    if (!isRecord(candidate)) return false
    const properties = record(candidate['properties'])
    const methodSchema = record(properties['method'])
    const paramsSchema = record(properties['params'])
    return array(methodSchema['enum']).includes(method)
      && paramsSchema['$ref'] === `#/definitions/${paramsName}`
      && hasRequired(candidate, 'id', 'method', 'params')
      && candidate['type'] === 'object'
  })
}

function hasNotificationMethod(
  schema: Record<string, unknown>,
  method: string,
  paramsName?: string,
): boolean {
  const branches = array(schema['oneOf'])
  return branches.some((candidate) => {
    if (!isRecord(candidate)) return false
    const properties = record(candidate['properties'])
    const methodSchema = record(properties['method'])
    const paramsSchema = record(properties['params'])
    return array(methodSchema['enum']).includes(method)
      && hasRequired(candidate, 'method')
      && candidate['type'] === 'object'
      && (paramsName === undefined
        ? true
        : hasRequired(candidate, 'params')
          && paramsSchema['$ref'] === `#/definitions/${paramsName}`)
  })
}

function missingDocument(
  documents: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  return isRecord(documents[path]) ? undefined : `protocol-document-missing:${path}`
}

function validInitializeParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const definitions = record(schema['definitions'])
  const clientInfo = record(definitions['ClientInfo'])
  const clientProperties = record(clientInfo['properties'])
  const capabilities = record(definitions['InitializeCapabilities'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'clientInfo')
    && record(properties['clientInfo'])['$ref'] === '#/definitions/ClientInfo'
    && clientInfo['type'] === 'object'
    && hasRequired(clientInfo, 'name', 'version')
    && record(clientProperties['name'])['type'] === 'string'
    && record(clientProperties['version'])['type'] === 'string'
    && capabilities['type'] === 'object'
    && record(record(capabilities['properties'])['experimentalApi'])['type'] === 'boolean'
}

function validInitializeResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'codexHome', 'platformFamily', 'platformOs', 'userAgent')
    && hasAllOfReference(record(properties['codexHome']), '#/definitions/AbsolutePathBuf')
    && record(properties['platformFamily'])['type'] === 'string'
    && record(properties['platformOs'])['type'] === 'string'
    && record(properties['userAgent'])['type'] === 'string'
}

function validThreadStartParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const sandboxMode = record(record(schema['definitions'])['SandboxMode'])
  return schema['type'] === 'object'
    && hasTypes(record(properties['cwd']), 'string', 'null')
    && hasTypes(record(properties['model']), 'string', 'null')
    && hasTypes(record(properties['developerInstructions']), 'string', 'null')
    && hasNullableReference(record(properties['sandbox']), '#/definitions/SandboxMode')
    && exactEnum(sandboxMode, 'read-only', 'workspace-write', 'danger-full-access')
}

function validThreadResumeParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return validThreadIdParams(schema)
    && hasTypes(record(properties['cwd']), 'string', 'null')
    && hasTypes(record(properties['model']), 'string', 'null')
}

function validThreadResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(
      schema,
      'approvalPolicy',
      'approvalsReviewer',
      'cwd',
      'model',
      'modelProvider',
      'sandbox',
      'thread',
    )
    && record(properties['thread'])['$ref'] === '#/definitions/Thread'
    && validThread(record(record(schema['definitions'])['Thread']))
}

function validThreadStartedNotification(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'thread')
    && record(properties['thread'])['$ref'] === '#/definitions/Thread'
    && validThread(record(record(schema['definitions'])['Thread']))
}

function validThread(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(
      schema,
      'cliVersion',
      'createdAt',
      'cwd',
      'ephemeral',
      'id',
      'modelProvider',
      'preview',
      'sessionId',
      'source',
      'status',
      'turns',
      'updatedAt',
    )
    && record(properties['cliVersion'])['type'] === 'string'
    && integer64(properties['createdAt'])
    && record(properties['ephemeral'])['type'] === 'boolean'
    && record(properties['id'])['type'] === 'string'
    && record(properties['modelProvider'])['type'] === 'string'
    && record(properties['preview'])['type'] === 'string'
    && record(properties['sessionId'])['type'] === 'string'
    && record(properties['turns'])['type'] === 'array'
    && integer64(properties['updatedAt'])
}

function validTurnStartParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const input = record(properties['input'])
  const userInput = record(record(schema['definitions'])['UserInput'])
  return validThreadIdParams(schema)
    && hasRequired(schema, 'input')
    && input['type'] === 'array'
    && record(input['items'])['$ref'] === '#/definitions/UserInput'
    && array(userInput['oneOf']).some((candidate) => validTextUserInput(record(candidate)))
}

function validTextUserInput(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'text', 'type')
    && record(properties['text'])['type'] === 'string'
    && exactEnum(record(properties['type']), 'text')
}

function validTurnResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'turn')
    && record(properties['turn'])['$ref'] === '#/definitions/Turn'
    && validTurn(
      record(record(schema['definitions'])['Turn']),
      record(record(schema['definitions'])['TurnStatus']),
    )
}

function validTurnNotification(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId', 'turn')
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turn'])['$ref'] === '#/definitions/Turn'
    && validTurn(
      record(record(schema['definitions'])['Turn']),
      record(record(schema['definitions'])['TurnStatus']),
    )
}

function validTurn(
  schema: Record<string, unknown>,
  statusSchema: Record<string, unknown>,
): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'id', 'items', 'status')
    && record(properties['id'])['type'] === 'string'
    && record(properties['items'])['type'] === 'array'
    && record(properties['status'])['$ref'] === '#/definitions/TurnStatus'
    && exactEnum(statusSchema, 'completed', 'interrupted', 'failed', 'inProgress')
}

function validTurnInterruptParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId', 'turnId')
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
}

function validEmptyObjectResponse(schema: Record<string, unknown>): boolean {
  return schema['type'] === 'object' && array(schema['required']).length === 0
}

function validAgentMessageDelta(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'delta', 'itemId', 'threadId', 'turnId')
    && ['delta', 'itemId', 'threadId', 'turnId']
      .every((key) => record(properties[key])['type'] === 'string')
}

function validTokenUsageNotification(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const definitions = record(schema['definitions'])
  const usage = record(definitions['ThreadTokenUsage'])
  const usageProperties = record(usage['properties'])
  const breakdown = record(definitions['TokenUsageBreakdown'])
  const breakdownProperties = record(breakdown['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId', 'tokenUsage', 'turnId')
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
    && record(properties['tokenUsage'])['$ref'] === '#/definitions/ThreadTokenUsage'
    && usage['type'] === 'object'
    && hasRequired(usage, 'last', 'total')
    && record(usageProperties['last'])['$ref'] === '#/definitions/TokenUsageBreakdown'
    && record(usageProperties['total'])['$ref'] === '#/definitions/TokenUsageBreakdown'
    && breakdown['type'] === 'object'
    && hasRequired(
      breakdown,
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    )
    && [
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    ].every((key) => integer64(breakdownProperties[key]))
}

function validApprovalParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'itemId', 'startedAtMs', 'threadId', 'turnId')
    && record(properties['itemId'])['type'] === 'string'
    && record(properties['startedAtMs'])['type'] === 'integer'
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
}

function validToolRequestUserInputParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'isBlocking', 'itemId', 'questions', 'threadId', 'turnId')
    && record(properties['isBlocking'])['type'] === 'boolean'
    && record(properties['itemId'])['type'] === 'string'
    && record(properties['questions'])['type'] === 'array'
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
}

function validThreadIdParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId')
    && record(properties['threadId'])['type'] === 'string'
}

function validGoalSetParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return validThreadIdParams(schema)
    && hasTypes(record(properties['objective']), 'string', 'null')
    && hasNullableReference(record(properties['status']), '#/definitions/ThreadGoalStatus')
    && hasTypes(record(properties['tokenBudget']), 'integer', 'null')
    && record(properties['tokenBudget'])['format'] === 'int64'
    && validGoalStatus(record(record(schema['definitions'])['ThreadGoalStatus']))
}

function validGoalResponse(schema: Record<string, unknown>, nullable: boolean): boolean {
  const properties = record(schema['properties'])
  const goal = record(properties['goal'])
  const reference = '#/definitions/ThreadGoal'
  const goalShapeValid = nullable
    ? hasNullableReference(goal, reference)
    : goal['$ref'] === reference && hasRequired(schema, 'goal')
  return schema['type'] === 'object'
    && goalShapeValid
    && validThreadGoal(record(record(schema['definitions'])['ThreadGoal']))
    && validGoalStatus(record(record(schema['definitions'])['ThreadGoalStatus']))
}

function validThreadGoal(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(
      schema,
      'createdAt',
      'objective',
      'status',
      'threadId',
      'timeUsedSeconds',
      'tokensUsed',
      'updatedAt',
    )
    && integer64(properties['createdAt'])
    && record(properties['objective'])['type'] === 'string'
    && record(properties['status'])['$ref'] === '#/definitions/ThreadGoalStatus'
    && record(properties['threadId'])['type'] === 'string'
    && integer64(properties['timeUsedSeconds'])
    && hasTypes(record(properties['tokenBudget']), 'integer', 'null')
    && record(properties['tokenBudget'])['format'] === 'int64'
    && integer64(properties['tokensUsed'])
    && integer64(properties['updatedAt'])
}

function validGoalStatus(schema: Record<string, unknown>): boolean {
  const statuses = array(schema['enum'])
  return schema['type'] === 'string'
    && statuses.length === GOAL_STATUSES.length
    && GOAL_STATUSES.every((status) => statuses.includes(status))
}

function validClearResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'cleared')
    && record(properties['cleared'])['type'] === 'boolean'
}

async function readSchemaCorpus(root: string): Promise<SchemaCorpus> {
  const files: CorpusFile[] = []
  await collectCorpusFiles(root, root, 0, files)
  files.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0)
  if (files.length === 0 || files.length > MAX_SCHEMA_FILES) {
    throw new SchemaCorpusError('protocol-schema-file-limit')
  }

  const hash = createHash('sha256')
  const documents: Record<string, unknown> = {}
  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.size
    if (file.size > MAX_SCHEMA_FILE_BYTES || totalBytes > MAX_SCHEMA_TOTAL_BYTES) {
      throw new SchemaCorpusError('protocol-schema-file-limit')
    }
    const bytes = await readFile(file.path)
    if (bytes.byteLength !== file.size) {
      throw new SchemaCorpusError('protocol-schema-invalid')
    }
    hash.update(file.relativePath).update('\0').update(bytes)
    if (REQUIRED_DOCUMENTS.includes(file.relativePath as typeof REQUIRED_DOCUMENTS[number])) {
      try {
        documents[file.relativePath] = JSON.parse(bytes.toString('utf8')) as unknown
      } catch {
        throw new SchemaCorpusError('protocol-schema-invalid')
      }
    }
  }
  return {
    documents,
    digest: `sha256:${hash.digest('hex')}`,
    fileCount: files.length,
  }
}

async function collectCorpusFiles(
  root: string,
  current: string,
  depth: number,
  files: CorpusFile[],
): Promise<void> {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaCorpusError('protocol-schema-file-limit')
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(current, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new SchemaCorpusError('protocol-schema-invalid')
    if (info.isDirectory()) {
      await collectCorpusFiles(root, path, depth + 1, files)
      continue
    }
    if (!info.isFile()) throw new SchemaCorpusError('protocol-schema-invalid')
    const relativePath = relative(root, path).split(sep).join('/')
    if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) {
      throw new SchemaCorpusError('protocol-schema-invalid')
    }
    files.push({ path, relativePath, size: info.size })
    if (files.length > MAX_SCHEMA_FILES) {
      throw new SchemaCorpusError('protocol-schema-file-limit')
    }
  }
}

class SchemaCorpusError extends Error {
  constructor(readonly reason: CodexGoalCapabilityObservationFailure) {
    super(reason)
  }
}

function failureReason(
  result: ProbeResult,
  fallback: CodexGoalCapabilityObservationFailure,
): CodexGoalCapabilityObservationFailure {
  if (result.failure === 'timeout') return 'protocol-observation-timeout'
  if (result.failure === 'output-limit') return 'protocol-observation-output-limit'
  if (processFailure(result.failure)) return 'protocol-observation-process-failure'
  return fallback
}

function processFailure(failure: ProbeFailureClassification | undefined): boolean {
  return failure !== undefined && [
    'missing-binary',
    'executable-identity-mismatch',
    'invalid-policy',
    'invalid-encoding',
    'spawn-error',
    'exit-nonzero',
    'signal-exit',
    'capture-error',
  ].includes(failure)
}

function successful(result: ProbeResult): boolean {
  return result.exitCode === 0
    && !result.spawnFailed
    && !result.timedOut
    && !result.failure
    && !result.truncated
}

function finiteTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OBSERVATION_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_OBSERVATION_TIMEOUT_MS) {
    throw new Error('Codex goal capability timeout must be between 1 and 10000 milliseconds')
  }
  return value
}

function assertObservationIdentity(input: CodexGoalCapabilityMaterializationInput): void {
  if (!input.observedAt || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('Codex goal capability observedAt must be an ISO timestamp')
  }
  if (input.providerId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.providerId)) {
    throw new Error('Codex goal capability providerId is invalid')
  }
}

function validSchemaDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value)
}

function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`
}

function validSchemaReference(value: string): boolean {
  return value.length <= 512
    && /^codex-app-server:\/\/[A-Za-z0-9._~/?=&%-]+$/u.test(value)
}

function integer64(value: unknown): boolean {
  const schema = record(value)
  return schema['type'] === 'integer' && schema['format'] === 'int64'
}

function hasTypes(schema: Record<string, unknown>, ...types: string[]): boolean {
  const actual = array(schema['type'])
  return actual.length === types.length && types.every((type) => actual.includes(type))
}

function hasNullableReference(schema: Record<string, unknown>, reference: string): boolean {
  const choices = array(schema['anyOf'])
  return choices.length === 2
    && choices.some((choice) => isRecord(choice) && choice['$ref'] === reference)
    && choices.some((choice) => isRecord(choice) && choice['type'] === 'null')
}

function hasAllOfReference(schema: Record<string, unknown>, reference: string): boolean {
  const choices = array(schema['allOf'])
  return choices.length === 1
    && isRecord(choices[0])
    && choices[0]['$ref'] === reference
}

function exactEnum(schema: Record<string, unknown>, ...values: string[]): boolean {
  const actual = array(schema['enum'])
  return schema['type'] === 'string'
    && actual.length === values.length
    && values.every((value) => actual.includes(value))
}

function hasRequired(schema: Record<string, unknown>, ...keys: string[]): boolean {
  const required = array(schema['required'])
  return keys.every((key) => required.includes(key))
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
