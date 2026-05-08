/**
 * state.json IO helpers for DzupAgentSyncer.
 *
 * Split out of `syncer.ts` (MC-017). Owns reading/writing the
 * sync section of `.dzupagent/state.json` plus the `readFileSafe` helper.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StateJson, SyncStateEntry } from './syncer-types.js'

export async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

export async function readStateJson(stateFile: string): Promise<StateJson> {
  const raw = await readFileSafe(stateFile)
  if (raw === undefined) {
    return { version: 1, projections: {}, files: {}, sync: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateJson>
    return {
      version: 1,
      projections: (parsed.projections && typeof parsed.projections === 'object') ? parsed.projections : {},
      files: (parsed.files && typeof parsed.files === 'object') ? parsed.files : {},
      sync: (parsed.sync && typeof parsed.sync === 'object') ? parsed.sync as Record<string, SyncStateEntry> : {},
    }
  } catch {
    return { version: 1, projections: {}, files: {}, sync: {} }
  }
}

export async function writeStateJson(stateFile: string, state: StateJson): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8')
}
