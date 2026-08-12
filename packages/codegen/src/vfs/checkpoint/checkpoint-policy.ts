import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CheckpointInternalError, safeNodeErrorCode } from './checkpoint-errors.js'
import type {
  CheckpointSettings,
  CheckpointStore,
  TreeAdmission,
} from './checkpoint-types.js'

const STORE_IDENTITY_VERSION = 1
const STORE_POLICY_VERSION = 1
const STORE_IDENTITY_FILE = 'root-identity.v1.json'

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
])

const EXCLUDED_FILE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
])

const EXCLUDED_FILE_SUFFIXES = ['.jks', '.key', '.p12', '.pem', '.pfx']

const STATIC_GIT_EXCLUDE_GLOBS = [
  ...[...EXCLUDED_DIRECTORY_NAMES].flatMap((name) => [
    `**/${name}`,
    `**/${name}/**`,
  ]),
  ...[...EXCLUDED_FILE_NAMES].map((name) => `**/${name}`),
  '**/.env.*',
  ...EXCLUDED_FILE_SUFFIXES.map((suffix) => `**/*${suffix}`),
]

export function checkpointRootSha256(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot).digest('hex')
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function normalizeRelativePath(value: string): string {
  return value.split(sep).join('/')
}

export function isExcludedRelativePath(relativePath: string): boolean {
  const lowerParts = relativePath.split('/').filter(Boolean).map((part) => part.toLowerCase())
  if (lowerParts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))) return true

  const basename = lowerParts.at(-1) ?? ''
  if (EXCLUDED_FILE_NAMES.has(basename)) return true
  if (basename.startsWith('.env.')) return true
  return EXCLUDED_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))
}

export function buildAddArgs(dynamicExcludes: string[]): string[] {
  const exclusions = STATIC_GIT_EXCLUDE_GLOBS.map(
    (pattern) => `:(top,exclude,icase,glob)${pattern}`,
  )
  for (const excludedPath of dynamicExcludes) {
    exclusions.push(`:(top,exclude,literal)${excludedPath}`)
  }
  return ['add', '-A', '--force', '--', '.', ...exclusions]
}

export class CheckpointPolicy {
  constructor(private readonly settings: CheckpointSettings) {}

  rootSha256(canonicalRoot: string): string {
    return checkpointRootSha256(canonicalRoot)
  }

  async canonicalizeRoot(workDir: string): Promise<string> {
    if (typeof workDir !== 'string' || workDir.includes('\0')) {
      throw new CheckpointInternalError('unsafe_input', 'checkpoint root is invalid')
    }

    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(resolve(workDir))
      if (!(await lstat(canonicalRoot)).isDirectory()) {
        throw new CheckpointInternalError('unsafe_input', 'checkpoint root is not a directory')
      }
    } catch (error: unknown) {
      if (error instanceof CheckpointInternalError) throw error
      const code = safeNodeErrorCode(error)
      throw new CheckpointInternalError(
        'io_failure',
        code ? `checkpoint root is unavailable (${code})` : 'checkpoint root is unavailable',
      )
    }

    let canonicalHome: string | null = null
    const configuredHome = process.env['HOME']
    if (configuredHome) {
      try {
        canonicalHome = await realpath(configuredHome)
      } catch {
        canonicalHome = null
      }
    }
    if (canonicalRoot === '/' || canonicalRoot === canonicalHome) {
      throw new CheckpointInternalError('unsafe_input', 'checkpoint root is too broad')
    }
    return canonicalRoot
  }

  async scanAdmittedTree(canonicalRoot: string): Promise<TreeAdmission> {
    const pending: Array<{ absolute: string; relative: string; depth: number }> = [
      { absolute: canonicalRoot, relative: '', depth: 0 },
    ]
    const dynamicExcludes: string[] = []
    let files = 0
    let totalBytes = 0

    while (pending.length > 0) {
      const current = pending.pop()!
      let entries
      try {
        entries = await readdir(current.absolute, { withFileTypes: true })
      } catch (error: unknown) {
        const code = safeNodeErrorCode(error)
        throw new CheckpointInternalError(
          'io_failure',
          code
            ? `checkpoint tree could not be inspected (${code})`
            : 'checkpoint tree could not be inspected',
        )
      }

      if (current.relative && entries.some((entry) => entry.name.toLowerCase() === '.git')) {
        dynamicExcludes.push(current.relative)
        continue
      }

      for (const entry of entries) {
        const relPath = normalizeRelativePath(
          current.relative ? join(current.relative, entry.name) : entry.name,
        )
        if (isExcludedRelativePath(relPath)) continue
        const depth = current.depth + 1
        this.validatePathBounds(relPath, depth)

        const absolutePath = join(current.absolute, entry.name)
        let entryStat
        try {
          entryStat = await lstat(absolutePath)
        } catch (error: unknown) {
          const code = safeNodeErrorCode(error)
          throw new CheckpointInternalError(
            'io_failure',
            code
              ? `checkpoint entry could not be inspected (${code})`
              : 'checkpoint entry could not be inspected',
          )
        }

        if (entryStat.isDirectory()) {
          pending.push({ absolute: absolutePath, relative: relPath, depth })
          continue
        }
        if (!entryStat.isFile() && !entryStat.isSymbolicLink()) {
          throw new CheckpointInternalError(
            'unsafe_input',
            'checkpoint tree contains an unsupported file type',
          )
        }

        files += 1
        if (files > this.settings.maxFiles) {
          throw new CheckpointInternalError(
            'resource_limit',
            `checkpoint tree exceeds maxFiles (${this.settings.maxFiles})`,
          )
        }
        if (entryStat.size > this.settings.maxFileBytes) {
          throw new CheckpointInternalError(
            'resource_limit',
            `checkpoint file exceeds maxFileBytes (${this.settings.maxFileBytes})`,
          )
        }
        totalBytes += entryStat.size
        if (!Number.isSafeInteger(totalBytes) || totalBytes > this.settings.maxTotalBytes) {
          throw new CheckpointInternalError(
            'resource_limit',
            `checkpoint tree exceeds maxTotalBytes (${this.settings.maxTotalBytes})`,
          )
        }
      }
    }
    return { dynamicExcludes, files, totalBytes }
  }

  async prepareStore(canonicalRoot: string): Promise<CheckpointStore> {
    if (isWithin(canonicalRoot, this.settings.baseDir)) {
      throw new CheckpointInternalError(
        'unsafe_input',
        'checkpoint storage cannot be inside the checkpoint root',
      )
    }
    await mkdir(this.settings.baseDir, { recursive: true, mode: 0o700 })
    const canonicalBase = await realpath(this.settings.baseDir)
    if (isWithin(canonicalRoot, canonicalBase)) {
      throw new CheckpointInternalError(
        'unsafe_input',
        'checkpoint storage cannot be inside the checkpoint root',
      )
    }

    const digest = checkpointRootSha256(canonicalRoot)
    const legacyDir = join(canonicalBase, digest.slice(0, 16))
    try {
      await lstat(legacyDir)
      throw new CheckpointInternalError(
        'legacy_store',
        'legacy checkpoint store requires explicit quarantine',
      )
    } catch (error: unknown) {
      if (error instanceof CheckpointInternalError) throw error
      if (safeNodeErrorCode(error) !== 'ENOENT') throw error
    }

    const storeDir = join(canonicalBase, digest)
    const gitDir = join(storeDir, 'repo')
    const identityPath = join(storeDir, STORE_IDENTITY_FILE)
    await mkdir(storeDir, { recursive: true, mode: 0o700 })
    const canonicalStore = await realpath(storeDir)
    const storeStat = await lstat(canonicalStore)
    if (canonicalStore !== storeDir || !storeStat.isDirectory() || (storeStat.mode & 0o077) !== 0) {
      throw new CheckpointInternalError(
        'corrupt_store',
        'checkpoint store path or permissions do not match policy',
      )
    }
    const expectedIdentity = {
      version: STORE_IDENTITY_VERSION,
      policyVersion: STORE_POLICY_VERSION,
      canonicalRoot,
      rootSha256: digest,
    }

    try {
      await writeFile(identityPath, `${JSON.stringify(expectedIdentity)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error: unknown) {
      if (safeNodeErrorCode(error) !== 'EEXIST') throw error
    }

    let actualIdentity: unknown
    try {
      const identityStat = await lstat(identityPath)
      if (!identityStat.isFile() || (identityStat.mode & 0o077) !== 0) {
        throw new Error('invalid identity file')
      }
      actualIdentity = JSON.parse(await readFile(identityPath, 'utf8'))
    } catch {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint root identity is unreadable')
    }
    const identity = actualIdentity as Record<string, unknown> | null
    if (
      !identity
      || Array.isArray(identity)
      || identity['version'] !== STORE_IDENTITY_VERSION
      || identity['policyVersion'] !== STORE_POLICY_VERSION
      || identity['canonicalRoot'] !== canonicalRoot
      || identity['rootSha256'] !== digest
    ) {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint root identity does not match')
    }
    return { storeDir: canonicalStore, gitDir, workDir: canonicalRoot }
  }

  private validatePathBounds(relPath: string, depth: number): void {
    if (depth > this.settings.maxDepth) {
      throw new CheckpointInternalError(
        'resource_limit',
        `checkpoint tree exceeds maxDepth (${this.settings.maxDepth})`,
      )
    }
    if (Buffer.byteLength(relPath, 'utf8') > this.settings.maxPathBytes) {
      throw new CheckpointInternalError(
        'resource_limit',
        `checkpoint path exceeds maxPathBytes (${this.settings.maxPathBytes})`,
      )
    }
  }
}
