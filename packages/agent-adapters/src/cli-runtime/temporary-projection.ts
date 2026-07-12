import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CleanupRegistry } from './cleanup-registry.js'

export interface TemporaryProjectionFile {
  readonly path: string
  readonly content: string
  readonly mode?: number | undefined
}

export interface TemporaryProjection {
  readonly root: string
  readonly paths: Readonly<Record<string, string>>
  cleanup(): Promise<void>
}

export async function createTemporaryProjection(
  prefix: string,
  files: Readonly<Record<string, TemporaryProjectionFile>>,
): Promise<TemporaryProjection> {
  const root = await mkdtemp(resolve(tmpdir(), prefix))
  const cleanup = new CleanupRegistry()
  cleanup.add(() => rm(root, { recursive: true, force: true }))
  const paths: Record<string, string> = {}

  try {
    for (const [id, file] of Object.entries(files)) {
      assertRelativeProjectionPath(file.path)
      const target = resolve(root, normalize(file.path))
      if (relative(root, target).startsWith('..')) throw new Error(`Projection path escapes its root: ${file.path}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode ?? 0o600, flag: 'wx' })
      paths[id] = target
    }
    return { root, paths: Object.freeze(paths), cleanup: () => cleanup.cleanup() }
  } catch (error) {
    await cleanup.cleanup().catch(() => undefined)
    throw error
  }
}

function assertRelativeProjectionPath(path: string): void {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/u.test(path) || /^\\\\/u.test(path) || normalize(path).split(/[\\/]/u).includes('..')) {
    throw new Error(`Projection path must be relative and contained: ${path}`)
  }
}
