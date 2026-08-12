import { CheckpointInternalError } from './checkpoint-errors.js'
import { isExcludedRelativePath } from './checkpoint-policy.js'
import type {
  CheckpointDiff,
  CheckpointSettings,
} from './checkpoint-types.js'

export function parseCheckpointDiff(nameStatus: string, shortStat: string): CheckpointDiff {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  const tokens = nameStatus.split('\0').filter((token) => token.length > 0)

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++]!
    const tab = token.indexOf('\t')
    const statusToken = tab >= 0 ? token.slice(0, tab) : token
    const path = tab >= 0 ? token.slice(tab + 1) : (tokens[index++] ?? '')
    const status = statusToken[0]
    if (!path) continue
    if (status === 'A') added.push(path)
    else if (status === 'D') deleted.push(path)
    else if (status === 'M' || status === 'T') modified.push(path)
  }

  const insertMatch = /(\d+) insertion/.exec(shortStat)
  const deleteMatch = /(\d+) deletion/.exec(shortStat)
  return {
    added,
    modified,
    deleted,
    stats: {
      filesChanged: added.length + modified.length + deleted.length,
      insertions: insertMatch ? Number(insertMatch[1]) : 0,
      deletions: deleteMatch ? Number(deleteMatch[1]) : 0,
    },
  }
}

export function validateStoredTreeOutput(
  output: string,
  settings: CheckpointSettings,
): void {
  let files = 0
  let totalBytes = 0

  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(-|\d+)\t([\s\S]+)$/.exec(record)
    if (!match) {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint tree entry is invalid')
    }
    const mode = match[1]!
    const type = match[2]!
    const path = match[5]!
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint tree contains an unsupported type')
    }
    if (
      path.startsWith('/')
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || isExcludedRelativePath(path)
    ) {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint tree contains an unsafe path')
    }

    const depth = path.split('/').length
    const size = Number(match[4]!)
    if (depth > settings.maxDepth || Buffer.byteLength(path, 'utf8') > settings.maxPathBytes) {
      throw new CheckpointInternalError('resource_limit', 'stored checkpoint path exceeds current limits')
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > settings.maxFileBytes) {
      throw new CheckpointInternalError('resource_limit', 'stored checkpoint file exceeds current limits')
    }
    files += 1
    totalBytes += size
    if (
      files > settings.maxFiles
      || !Number.isSafeInteger(totalBytes)
      || totalBytes > settings.maxTotalBytes
    ) {
      throw new CheckpointInternalError('resource_limit', 'stored checkpoint tree exceeds current limits')
    }
  }
}
