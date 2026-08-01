import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  BUILD_ARTIFACT_MANIFEST,
  verifyBuildArtifactManifest,
} from './build-artifact-integrity.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let activeChild

export function turboCacheArguments({ cacheDir, mode, writeOnly = false }) {
  const cache = mode === 'remote' ? 'remote' : 'local'
  const args = [
    'turbo',
    'run',
    'build',
    '--output-logs=hash-only',
    `--cache=${cache}:${writeOnly ? 'w' : 'rw'}`,
  ]
  if (mode === 'local') args.push(`--cache-dir=${cacheDir}`)
  return args
}

export function selectPartialRestoreArtifacts(artifacts) {
  const runtime = artifacts.find((artifact) => artifact.path.endsWith('.js'))
  const declaration = artifacts.find((artifact) => artifact.path.endsWith('.d.ts'))
  if (!runtime || !declaration) {
    throw new Error('qualification package must produce JavaScript and declarations')
  }
  return [runtime.path, declaration.path, BUILD_ARTIFACT_MANIFEST]
}

function scrubOutput(output) {
  return output.replaceAll(repoRoot, '<repo>')
}

async function runTurbo({ cacheDir, mode, packageName, writeOnly }) {
  const args = [
    ...turboCacheArguments({ cacheDir, mode, writeOnly }),
    `--filter=${packageName}`,
  ]
  const output = await new Promise((resolve, reject) => {
    const child = spawn('yarn', args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeChild = child
    let combined = ''
    child.stdout.on('data', (chunk) => { combined += chunk })
    child.stderr.on('data', (chunk) => { combined += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      activeChild = undefined
      if (code === 0 && !signal) resolve(combined)
      else reject(new Error(
        `Turbo cache phase failed (${signal ?? code})\n${scrubOutput(combined)}`,
      ))
    })
  })
  return output
}

async function packageDirForName(packageName) {
  const packagesDir = path.join(repoRoot, 'packages')
  const entries = await readdir(packagesDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const relativeDir = path.posix.join('packages', entry.name)
    const packageJsonPath = path.join(repoRoot, relativeDir, 'package.json')
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
      if (packageJson.name === packageName) return relativeDir
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`unknown build workspace ${packageName}`)
}

async function requireValidArtifacts(packageDir, expectedFingerprint) {
  const result = await verifyBuildArtifactManifest({ root: repoRoot, packageDir })
  if (!result.ok) throw new Error(result.messages.join('\n'))
  if (
    expectedFingerprint
    && result.manifest.artifactFingerprint !== expectedFingerprint
  ) {
    throw new Error('cache restore adopted a different artifact generation')
  }
  return result.manifest
}

export async function qualifyBuildCacheArtifacts({
  mode = 'local',
  packageName = '@dzupagent/cache',
} = {}) {
  if (!['local', 'remote'].includes(mode)) throw new Error(`unsupported cache mode ${mode}`)
  if (
    mode === 'remote'
    && (!process.env.TURBO_TOKEN || !process.env.TURBO_TEAM)
  ) {
    throw new Error('remote qualification requires TURBO_TOKEN and TURBO_TEAM')
  }

  const packageDir = await packageDirForName(packageName)
  const packageRoot = path.join(repoRoot, packageDir)
  const distDir = path.join(packageRoot, 'dist')
  await mkdir(path.join(repoRoot, '.turbo'), { recursive: true })
  const custodyDir = await mkdtemp(path.join(repoRoot, '.turbo', 'cache-qualification-'))
  const originalDist = path.join(custodyDir, 'original-dist')
  const cacheDir = path.join(custodyDir, 'turbo-cache')
  let hadOriginalDist = false

  try {
    try {
      await rename(distDir, originalDist)
      hadOriginalDist = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    await runTurbo({ cacheDir, mode, packageName, writeOnly: true })
    const cold = await requireValidArtifacts(packageDir)
    const fingerprint = cold.artifactFingerprint

    await rm(distDir, { recursive: true, force: true })
    const warmOutput = await runTurbo({ cacheDir, mode, packageName, writeOnly: false })
    if (warmOutput.includes(repoRoot)) {
      throw new Error('warm cache replay exposed an absolute custody-worktree path')
    }
    await requireValidArtifacts(packageDir, fingerprint)

    for (const artifactPath of selectPartialRestoreArtifacts(cold.artifacts)) {
      await unlink(path.join(distDir, artifactPath))
    }
    await runTurbo({ cacheDir, mode, packageName, writeOnly: false })
    await requireValidArtifacts(packageDir, fingerprint)

    return {
      artifactCount: cold.artifacts.length,
      fingerprint,
      mode,
      packageName,
    }
  } finally {
    await rm(distDir, { recursive: true, force: true })
    if (hadOriginalDist) await rename(originalDist, distDir)
    await rm(custodyDir, { recursive: true, force: true })
  }
}

function parseArgs(args) {
  const mode = args.includes('--remote') ? 'remote' : 'local'
  const packageArg = args.find((arg) => arg.startsWith('--package='))
  return {
    mode,
    packageName: packageArg?.slice('--package='.length) || '@dzupagent/cache',
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const forwardSignal = (signal) => {
    if (activeChild && !activeChild.killed) activeChild.kill(signal)
  }
  const forwardInterrupt = () => forwardSignal('SIGINT')
  const forwardTermination = () => forwardSignal('SIGTERM')
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTermination)
  try {
    const result = await qualifyBuildCacheArtifacts(parseArgs(process.argv.slice(2)))
    console.log(
      `build-cache-qualification: ok (${result.mode}, ${result.packageName}, `
        + `${result.artifactCount} artifacts)`,
    )
  } catch (error) {
    console.error(`build-cache-qualification: ${error.message}`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', forwardInterrupt)
    process.off('SIGTERM', forwardTermination)
  }
}
