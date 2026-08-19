import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  type ProviderSessionCapability,
  type ProviderSessionCapabilityDescriptor,
  type ProviderSessionCapabilityMap,
} from '@dzupagent/runtime-contracts/provider-session'

import {
  createNodeProbeRunner,
  parseVersion,
  type ProbeFailureClassification,
  type ProbeResult,
  type SafeProbeCommandRunner,
} from '../introspection/index.js'

import {
  DEFAULT_OBSERVATION_TIMEOUT_MS,
  PROVIDER_ID,
  type CapabilityReasonMap,
  type CodexAppServerCapabilityMaterializationInput,
  type CodexGoalCapabilityMaterializationInput,
  type CodexGoalCapabilityObservationFailure,
  type ObserveInstalledCodexAppServerCapabilityOptions,
  type ObserveInstalledCodexGoalCapabilityOptions,
} from './codex-goal-capability-contracts.js'
import {
  SchemaCorpusError,
  readSchemaCorpus,
  type SchemaCorpus,
} from './codex-goal-capability-corpus.js'
import { inspectAppServerProtocol } from './codex-goal-capability-protocol.js'

// PUBLIC API, not a convenience: `codex-goal-control.ts` and the package export
// map name every public type through THIS path, so each declaration moved into
// `-contracts.ts` stays re-exported here. The list is explicit rather than
// `export *` so the internal probe limits and method tables that the layering
// also shares do not leak into the published surface.
export type {
  CodexAppServerCapabilityMaterializationInput,
  CodexAppServerProtocolObservation,
  CodexGoalCapabilityBackendKind,
  CodexGoalCapabilityMaterializationInput,
  CodexGoalCapabilityObservationFailure,
  CodexGoalProtocolObservation,
  ObserveInstalledCodexAppServerCapabilityOptions,
  ObserveInstalledCodexGoalCapabilityOptions,
} from './codex-goal-capability-contracts.js'

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
