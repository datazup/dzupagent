import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface CliRuntimeLimits {
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly lineBytes: number
  readonly records: number
  readonly diagnostics: number
}

export const DEFAULT_CLI_RUNTIME_LIMITS: CliRuntimeLimits = Object.freeze({
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  lineBytes: 1024 * 1024,
  records: 50_000,
  diagnostics: 100,
})

export type MalformedLinePolicy = 'skip' | 'error'

export interface CliRunSpecification {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly homeProjection?: CliHomeProjection | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly terminationGraceMs?: number | undefined
  readonly limits?: Partial<CliRuntimeLimits> | undefined
  readonly malformedLinePolicy?: MalformedLinePolicy | undefined
  readonly stdinResponder?: ((record: Record<string, unknown>) => Promise<string | null>) | undefined
}

export interface CliRuntimeDiagnostic {
  readonly kind: 'malformed_line' | 'stderr' | 'cli_home_projection_created' | 'cli_home_projection_cleanup_status'
  readonly message: string
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

export interface CliHomeGeneratedFile {
  readonly path: string
  readonly content: string
  readonly mode?: number | undefined
}

export interface CliHomeBaseProfileInput {
  readonly sourcePath: string
  readonly targetPath: string
  readonly mode?: number | undefined
}

export interface CliHomeProjectionSpecification {
  readonly prefix: string
  readonly envVar?: string | undefined
  readonly generatedFiles?: Readonly<Record<string, CliHomeGeneratedFile>> | undefined
  readonly baseProfileInputs?: Readonly<Record<string, CliHomeBaseProfileInput>> | undefined
  readonly approvedBaseProfileRoots?: readonly string[] | undefined
  readonly requiredDirectories?: readonly string[] | undefined
}

export interface CliHomeProjection {
  readonly root: string
  readonly env: Readonly<Record<string, string>>
  readonly generatedPaths: Readonly<Record<string, string>>
  readonly baseProfilePaths: Readonly<Record<string, string>>
  readonly requiredDirectories: readonly string[]
  cleanup(): Promise<void>
}

export interface CliRuntimeDependencies {
  readonly spawn?: ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess) | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly killProcessTree?: ((child: ChildProcess, signal: NodeJS.Signals) => void) | undefined
  readonly setTimer?: typeof setTimeout | undefined
  readonly clearTimer?: typeof clearTimeout | undefined
  readonly onDiagnostic?: ((diagnostic: CliRuntimeDiagnostic) => void) | undefined
}
