import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import { isBinaryAvailable, spawnAndStreamJsonl } from '../utils/process-helpers.js'

export async function collectEvents<T>(
  gen: AsyncGenerator<T, void, undefined>,
): Promise<T[]> {
  const events: T[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

export function loadJsonFixture<T>(baseUrl: string, relativePath: string): T {
  const thisDir = dirname(fileURLToPath(baseUrl))
  const fixturePath = join(thisDir, relativePath)
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as T
}

export function getProcessHelperMocks() {
  return {
    mockIsBinaryAvailable: vi.mocked(isBinaryAvailable),
    mockSpawnAndStreamJsonl: vi.mocked(spawnAndStreamJsonl),
  }
}
