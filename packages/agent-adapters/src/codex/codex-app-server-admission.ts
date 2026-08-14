import { isAbsolute } from 'node:path'

import {
  validateProviderSessionAttemptBinding,
  type ProviderSessionAttemptBinding,
  type ProviderSessionCapability,
} from '@dzupagent/runtime-contracts/provider-session'

import type { ResolvedProbeExecutable } from '../introspection/index.js'
import { validExecutableArtifactDigest } from '../introspection/executable-artifact.js'

interface CodexAppServerAdmissionOptions {
  readonly attemptBinding: ProviderSessionAttemptBinding
  readonly executable: ResolvedProbeExecutable
}

interface CodexAppServerAdmissionErrors {
  readonly binding: string
  readonly executable: string
}

/** Shared fail-closed admission for every Codex App Server process surface. */
export function assertExactCodexAppServerAdmission(
  options: CodexAppServerAdmissionOptions,
  requiredCapabilities: readonly ProviderSessionCapability[],
  errors: CodexAppServerAdmissionErrors,
): void {
  const admission = validateProviderSessionAttemptBinding(
    options.attemptBinding,
    requiredCapabilities,
  )
  const descriptor = options.attemptBinding.descriptor
  if (
    !admission.valid
    || descriptor.providerId !== 'codex'
    || descriptor.backend.kind !== 'app-server'
    || !boundedText(descriptor.backend.version, 128)
    || !boundedText(descriptor.backend.protocolSchemaRef, 512)
    || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.backend.protocolSchemaDigest ?? '')
    || !validExecutableArtifactDigest(descriptor.backend.artifactDigest)
  ) {
    throw new Error(errors.binding)
  }

  const executable = options.executable
  if (
    !executable
    || executable.name !== 'codex'
    || !isAbsolute(executable.path)
    || !isAbsolute(executable.realPath)
    || !validExecutableArtifactDigest(executable.artifactDigest)
    || executable.artifactDigest !== descriptor.backend.artifactDigest
  ) {
    throw new Error(errors.executable)
  }
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}
