import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CleanupRegistry } from './cleanup-registry.js'
import type {
  CliHomeBaseProfileInput,
  CliHomeGeneratedFile,
  CliHomeProjection,
  CliHomeProjectionSpecification,
} from './types.js'

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

export async function createCliHomeProjection(
  specification: CliHomeProjectionSpecification,
): Promise<CliHomeProjection> {
  const root = await mkdtemp(resolve(tmpdir(), specification.prefix))
  const cleanup = new CleanupRegistry()
  cleanup.add(() => rm(root, { recursive: true, force: true }))
  const generatedPaths: Record<string, string> = {}
  const baseProfilePaths: Record<string, string> = {}
  const requiredDirectories: string[] = []

  try {
    for (const directory of specification.requiredDirectories ?? []) {
      assertRelativeProjectionPath(directory)
      const target = containedTarget(root, directory)
      await mkdir(target, { recursive: true, mode: 0o700 })
      await assertContainedRealPath(root, target)
      requiredDirectories.push(target)
    }

    for (const [id, file] of Object.entries(specification.generatedFiles ?? {})) {
      const target = await writeProjectedTextFile(root, file)
      generatedPaths[id] = target
    }

    const approvedRoots = await resolveApprovedRoots(specification.approvedBaseProfileRoots ?? [])
    for (const [id, input] of Object.entries(specification.baseProfileInputs ?? {})) {
      const target = await copyApprovedBaseProfileInput(root, input, approvedRoots)
      baseProfilePaths[id] = target
    }

    return {
      root,
      env: Object.freeze(specification.envVar ? { [specification.envVar]: root } : {}),
      generatedPaths: Object.freeze(generatedPaths),
      baseProfilePaths: Object.freeze(baseProfilePaths),
      requiredDirectories: Object.freeze(requiredDirectories),
      cleanup: () => cleanup.cleanup(),
    }
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

async function writeProjectedTextFile(root: string, file: CliHomeGeneratedFile): Promise<string> {
  assertRelativeProjectionPath(file.path)
  const target = containedTarget(root, file.path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await assertContainedRealPath(root, dirname(target))
  await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode ?? 0o600, flag: 'wx' })
  return target
}

async function copyApprovedBaseProfileInput(
  root: string,
  input: CliHomeBaseProfileInput,
  approvedRoots: readonly string[],
): Promise<string> {
  if (approvedRoots.length === 0) throw new Error('Base-profile inputs require at least one approved source root')
  if (!isAbsolute(input.sourcePath)) throw new Error(`Base-profile input source must be absolute: ${input.sourcePath}`)
  assertRelativeProjectionPath(input.targetPath)
  const source = await realpath(input.sourcePath)
  if (!isContainedByAny(source, approvedRoots)) throw new Error(`Base-profile input is not under an approved root: ${input.sourcePath}`)
  const sourceInfo = await stat(source)
  if (!sourceInfo.isFile()) throw new Error(`Base-profile input must be a regular file: ${input.sourcePath}`)
  const target = containedTarget(root, input.targetPath)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await assertContainedRealPath(root, dirname(target))
  await writeFile(target, await readFile(source), { mode: input.mode ?? 0o600, flag: 'wx' })
  return target
}

async function resolveApprovedRoots(roots: readonly string[]): Promise<readonly string[]> {
  return Promise.all(roots.map(async (root) => {
    if (!isAbsolute(root)) throw new Error(`Approved base-profile root must be absolute: ${root}`)
    const resolved = await realpath(root)
    const info = await stat(resolved)
    if (!info.isDirectory()) throw new Error(`Approved base-profile root must be a directory: ${root}`)
    return resolved
  }))
}

function containedTarget(root: string, relativePath: string): string {
  const target = resolve(root, normalize(relativePath))
  const targetRelative = relative(root, target)
  if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) throw new Error(`Projection path escapes its root: ${relativePath}`)
  return target
}

async function assertContainedRealPath(root: string, target: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
  const rootRelative = relative(realRoot, realTarget)
  if (rootRelative.startsWith('..') || isAbsolute(rootRelative)) throw new Error(`Projection path escapes its root: ${target}`)
}

function isContainedByAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const fromRoot = relative(root, path)
    return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
  })
}
