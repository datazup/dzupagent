import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CheckpointInternalError } from './checkpoint-errors.js'
import type { CheckpointSettings, CheckpointStore, GitResult } from './checkpoint-types.js'

const execFileAsync = promisify(execFile)
const NULL_GIT_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'

function sanitizedProcessEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
}

export class CheckpointGit {
  constructor(private readonly settings: CheckpointSettings) {}

  async withTemporaryIndex<T>(
    store: CheckpointStore,
    operation: (indexFile: string) => Promise<T>,
  ): Promise<T> {
    const tempDir = await mkdtemp(join(store.storeDir, 'index-'))
    try {
      return await operation(join(tempDir, 'index'))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async run(
    store: CheckpointStore,
    args: string[],
    options?: { indexFile?: string; allowedExitCodes?: number[] },
  ): Promise<GitResult> {
    const allowedExitCodes = options?.allowedExitCodes ?? [0]
    try {
      const result = await execFileAsync('git', args, {
        cwd: store.workDir,
        timeout: this.settings.timeoutMs,
        maxBuffer: this.settings.maxGitOutputBytes,
        encoding: 'utf8',
        env: {
          ...sanitizedProcessEnvironment(),
          GIT_DIR: store.gitDir,
          GIT_WORK_TREE: store.workDir,
          GIT_ATTR_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: NULL_GIT_CONFIG,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...(options?.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
        },
      })
      return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 }
    } catch (error: unknown) {
      const processError = error as {
        code?: unknown
        killed?: unknown
        signal?: unknown
        stdout?: unknown
        stderr?: unknown
      }
      const exitCode = typeof processError.code === 'number' ? processError.code : null
      if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
        return {
          stdout: String(processError.stdout ?? ''),
          stderr: String(processError.stderr ?? ''),
          exitCode,
        }
      }
      if (
        processError.killed === true
        || processError.code === 'ETIMEDOUT'
        || processError.signal === 'SIGTERM'
      ) {
        throw new CheckpointInternalError('timeout', 'checkpoint Git command timed out')
      }
      throw new CheckpointInternalError(
        'git_failure',
        exitCode === null
          ? 'checkpoint Git command failed'
          : `checkpoint Git command failed (exit ${exitCode})`,
      )
    }
  }
}
