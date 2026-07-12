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
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly terminationGraceMs?: number | undefined
  readonly limits?: Partial<CliRuntimeLimits> | undefined
  readonly malformedLinePolicy?: MalformedLinePolicy | undefined
  readonly stdinResponder?: ((record: Record<string, unknown>) => Promise<string | null>) | undefined
}

export interface CliRuntimeDiagnostic {
  readonly kind: 'malformed_line' | 'stderr'
  readonly message: string
}

export interface CliRuntimeDependencies {
  readonly spawn?: ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess) | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly killProcessTree?: ((child: ChildProcess, signal: NodeJS.Signals) => void) | undefined
  readonly setTimer?: typeof setTimeout | undefined
  readonly clearTimer?: typeof clearTimeout | undefined
  readonly onDiagnostic?: ((diagnostic: CliRuntimeDiagnostic) => void) | undefined
}

