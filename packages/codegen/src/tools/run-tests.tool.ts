/**
 * Generic run-tests tool — executes tests via SandboxProtocol.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { SandboxProtocol } from '../sandbox/sandbox-protocol.js'

export function createRunTestsTool(sandbox: SandboxProtocol) {
  return tool(
    async ({ testCommand, timeoutMs }) => {
      const available = await sandbox.isAvailable()
      if (!available) {
        return JSON.stringify({
          action: 'run_tests',
          success: false,
          error: 'Sandbox is not available. Cannot execute tests.',
        })
      }

      const result = await sandbox.execute(
        testCommand ?? 'npx vitest run --reporter=json',
        { timeoutMs: timeoutMs ?? 60000 },
      )

      return JSON.stringify({
        action: 'run_tests',
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 5000),
        stderr: result.stderr.slice(0, 2000),
        timedOut: result.timedOut,
      })
    },
    {
      name: 'run_tests',
      description: 'Execute tests in an isolated sandbox environment. Returns test results including stdout, stderr, and exit code.',
      schema: z.object({
        testCommand: z.string().optional().describe('Test command to run (default: npx vitest run --reporter=json)'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: 60000)'),
      }),
    },
  )
}
