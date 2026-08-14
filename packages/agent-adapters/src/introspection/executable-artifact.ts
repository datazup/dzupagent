import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

const DIGEST_CHUNK_BYTES = 64 * 1024
const MAX_EXECUTABLE_ARTIFACT_BYTES = 512 * 1024 * 1024

export function validExecutableArtifactDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

/**
 * Hash one opened executable artifact with a finite byte ceiling.
 *
 * Opening before reading pins the inspected inode across ordinary pathname
 * replacement. The caller still rechecks immediately around spawn because a
 * path can change after this function closes the handle.
 */
export async function digestExecutableArtifact(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > MAX_EXECUTABLE_ARTIFACT_BYTES) {
      throw new Error('Executable artifact is not a bounded regular file')
    }

    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES)
    let offset = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      if (offset > MAX_EXECUTABLE_ARTIFACT_BYTES) {
        throw new Error('Executable artifact exceeded its byte limit')
      }
      hash.update(chunk.subarray(0, bytesRead))
    }

    const after = await handle.stat()
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || offset !== after.size
    ) {
      throw new Error('Executable artifact changed while being inspected')
    }
    return `sha256:${hash.digest('hex')}`
  } finally {
    await handle.close()
  }
}
