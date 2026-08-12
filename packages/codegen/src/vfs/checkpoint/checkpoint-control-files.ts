import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CheckpointInternalError, safeNodeErrorCode } from './checkpoint-errors.js'

const MAX_CONTROL_FILE_BYTES = 64 * 1024

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error: unknown) {
    if (
      process.platform === 'win32'
      && ['EACCES', 'EINVAL', 'EPERM'].includes(safeNodeErrorCode(error) ?? '')
    ) return
    throw error
  } finally {
    await handle?.close()
  }
}

export async function writeControlJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  const temporary = join(parent, `.control-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(parent)
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    const code = safeNodeErrorCode(error)
    throw new CheckpointInternalError(
      'io_failure',
      code
        ? `checkpoint control record could not be persisted (${code})`
        : 'checkpoint control record could not be persisted',
    )
  }
}

export async function readControlText(path: string): Promise<string | null> {
  try {
    const value = await readFile(path, 'utf8')
    if (Buffer.byteLength(value, 'utf8') > MAX_CONTROL_FILE_BYTES) {
      throw new CheckpointInternalError(
        'recovery_required',
        'checkpoint control record exceeds its byte limit',
      )
    }
    return value
  } catch (error: unknown) {
    if (safeNodeErrorCode(error) === 'ENOENT') return null
    if (error instanceof CheckpointInternalError) throw error
    const code = safeNodeErrorCode(error)
    throw new CheckpointInternalError(
      'io_failure',
      code
        ? `checkpoint control record could not be read (${code})`
        : 'checkpoint control record could not be read',
    )
  }
}

export async function removeControlFile(path: string): Promise<void> {
  try {
    await unlink(path)
    await syncDirectory(dirname(path))
  } catch (error: unknown) {
    if (safeNodeErrorCode(error) === 'ENOENT') return
    const code = safeNodeErrorCode(error)
    throw new CheckpointInternalError(
      'io_failure',
      code
        ? `checkpoint control record could not be removed (${code})`
        : 'checkpoint control record could not be removed',
    )
  }
}
