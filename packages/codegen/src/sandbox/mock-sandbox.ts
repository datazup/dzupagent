/**
 * In-memory mock sandbox for testing.
 * Stores uploaded files, records executed commands,
 * and returns pre-configured results.
 */

import type { SandboxProtocol, ExecResult, ExecOptions } from './sandbox-protocol.js'

interface ConfiguredResult {
  matcher: RegExp | string
  result: ExecResult
}

export class MockSandbox implements SandboxProtocol {
  private files: Record<string, string> = {}
  private executedCommands: string[] = []
  private configuredResults: ConfiguredResult[] = []
  private available = true

  /** Pre-configure a result for commands matching the given pattern. */
  configure(command: RegExp | string, result: ExecResult): this {
    this.configuredResults.push({ matcher: command, result })
    return this
  }

  /** Set whether isAvailable() returns true or false. */
  setAvailable(available: boolean): this {
    this.available = available
    return this
  }

  /** Get the list of commands that were executed. */
  getExecutedCommands(): string[] {
    return [...this.executedCommands]
  }

  /** Get a copy of the uploaded files. */
  getUploadedFiles(): Record<string, string> {
    return { ...this.files }
  }

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      this.files[path] = content
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const path of paths) {
      const content = this.files[path]
      if (content !== undefined) {
        result[path] = content
      }
    }
    return result
  }

  async execute(command: string, _options?: ExecOptions): Promise<ExecResult> {
    this.executedCommands.push(command)

    for (const { matcher, result } of this.configuredResults) {
      if (typeof matcher === 'string') {
        if (command === matcher || command.includes(matcher)) {
          return { ...result }
        }
      } else if (matcher.test(command)) {
        return { ...result }
      }
    }

    // Default: success with empty output
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  }

  async cleanup(): Promise<void> {
    this.files = {}
    this.executedCommands = []
    this.configuredResults = []
  }
}
