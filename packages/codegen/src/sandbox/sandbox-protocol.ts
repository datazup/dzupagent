/**
 * Abstract protocol for executing commands in an isolated sandbox.
 * Implementations: DockerSandbox (production), MockSandbox (testing).
 */

export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SandboxProtocol {
  execute(command: string, options?: ExecOptions): Promise<ExecResult>
  uploadFiles(files: Record<string, string>): Promise<void>
  downloadFiles(paths: string[]): Promise<Record<string, string>>
  cleanup(): Promise<void>
  isAvailable(): Promise<boolean>
}
