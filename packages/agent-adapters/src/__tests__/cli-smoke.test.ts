import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

import { isBinaryAvailable } from '../utils/process-helpers.js'

interface SmokeProbeResult {
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
}

function runProbe(binary: string, args: string[]): SmokeProbeResult {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 7_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

async function assertCliResponds(binary: string): Promise<void> {
  const available = await isBinaryAvailable(binary)
  if (!available) return

  const help = runProbe(binary, ['--help'])
  expect(help.signal).toBeNull()
  expect(help.timedOut).toBe(false)

  // Version probes are commonly supported and should return quickly.
  const version = runProbe(binary, ['--version'])
  expect(version.signal).toBeNull()
  expect(version.timedOut).toBe(false)

  // Some CLIs exit non-zero for help/version in constrained runtimes.
  // The smoke requirement is that the binary responds without hanging or crashing.
  expect(help.status !== null || version.status !== null).toBe(true)
}

describe('CLI smoke (optional, binary-gated)', () => {
  it('gemini responds to help/version when installed', async () => {
    await assertCliResponds('gemini')
  }, 15_000)

  it('qwen responds to help/version when installed', async () => {
    await assertCliResponds('qwen')
  }, 15_000)

  it('crush responds to help/version when installed', async () => {
    await assertCliResponds('crush')
  }, 15_000)
})
