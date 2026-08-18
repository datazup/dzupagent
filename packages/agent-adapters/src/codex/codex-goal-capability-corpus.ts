/**
 * Bounded, symlink-refusing reader for the schema corpus Codex generates into a
 * throwaway directory.
 *
 * Every limit here is a containment boundary, not a performance knob: the probe
 * reads whatever an installed third-party binary chose to emit, so file count,
 * per-file size, total size, and directory depth all fail closed, and any
 * symlink or non-regular entry aborts the read outright.
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import {
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_FILES,
  MAX_SCHEMA_FILE_BYTES,
  MAX_SCHEMA_TOTAL_BYTES,
  REQUIRED_DOCUMENTS,
  type CodexGoalCapabilityObservationFailure,
} from './codex-goal-capability-contracts.js'

export interface SchemaCorpus {
  readonly documents: Readonly<Record<string, unknown>>
  readonly digest: string
  readonly fileCount: number
}

interface CorpusFile {
  readonly path: string
  readonly relativePath: string
  readonly size: number
}

export class SchemaCorpusError extends Error {
  constructor(readonly reason: CodexGoalCapabilityObservationFailure) {
    super(reason)
  }
}

export async function readSchemaCorpus(root: string): Promise<SchemaCorpus> {
  const files: CorpusFile[] = []
  await collectCorpusFiles(root, root, 0, files)
  files.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0)
  if (files.length === 0 || files.length > MAX_SCHEMA_FILES) {
    throw new SchemaCorpusError('protocol-schema-file-limit')
  }

  const hash = createHash('sha256')
  const documents: Record<string, unknown> = {}
  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.size
    if (file.size > MAX_SCHEMA_FILE_BYTES || totalBytes > MAX_SCHEMA_TOTAL_BYTES) {
      throw new SchemaCorpusError('protocol-schema-file-limit')
    }
    const bytes = await readFile(file.path)
    if (bytes.byteLength !== file.size) {
      throw new SchemaCorpusError('protocol-schema-invalid')
    }
    hash.update(file.relativePath).update('\0').update(bytes)
    if (REQUIRED_DOCUMENTS.includes(file.relativePath as typeof REQUIRED_DOCUMENTS[number])) {
      try {
        documents[file.relativePath] = JSON.parse(bytes.toString('utf8')) as unknown
      } catch {
        throw new SchemaCorpusError('protocol-schema-invalid')
      }
    }
  }
  return {
    documents,
    digest: `sha256:${hash.digest('hex')}`,
    fileCount: files.length,
  }
}

async function collectCorpusFiles(
  root: string,
  current: string,
  depth: number,
  files: CorpusFile[],
): Promise<void> {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaCorpusError('protocol-schema-file-limit')
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(current, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new SchemaCorpusError('protocol-schema-invalid')
    if (info.isDirectory()) {
      await collectCorpusFiles(root, path, depth + 1, files)
      continue
    }
    if (!info.isFile()) throw new SchemaCorpusError('protocol-schema-invalid')
    const relativePath = relative(root, path).split(sep).join('/')
    if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) {
      throw new SchemaCorpusError('protocol-schema-invalid')
    }
    files.push({ path, relativePath, size: info.size })
    if (files.length > MAX_SCHEMA_FILES) {
      throw new SchemaCorpusError('protocol-schema-file-limit')
    }
  }
}
