import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

export const BUILD_ARTIFACT_MANIFEST = '.dzup-build-artifacts.json'
export const BUILD_ARTIFACT_SCHEMA_VERSION = 1
export const BUILD_INPUT_SNAPSHOT = '.dzup-build-inputs.json'

const ROOT_BUILD_INPUTS = [
  '.yarnrc.yml',
  'package.json',
  'turbo.json',
  'tsconfig.json',
  'yarn.lock',
  'scripts/build-artifact-integrity.mjs',
  'scripts/build-custody.mjs',
  'scripts/check-package-export-artifacts.mjs',
  'scripts/prepare-build-artifact-manifest.mjs',
  'scripts/run-with-build-custody.mjs',
  'scripts/write-build-artifact-manifest.mjs',
]

function toPosix(value) {
  return value.split(path.sep).join('/')
}

async function isFile(filePath) {
  try {
    return (await lstat(filePath)).isFile()
  } catch {
    return false
  }
}

async function collectTreeFiles(root, relativeDir, options = {}) {
  const absoluteDir = path.join(root, relativeDir)
  let entries
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' && options.optional) return []
    throw error
  }

  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDir, entry.name)
    if (options.exclude?.has(toPosix(relativePath))) continue
    if (entry.isSymbolicLink()) {
      throw new Error(`build artifact inputs and outputs cannot be symlinks: ${toPosix(relativePath)}`)
    }
    if (entry.isDirectory()) {
      files.push(...await collectTreeFiles(root, relativePath, options))
    } else if (entry.isFile()) {
      files.push(toPosix(relativePath))
    }
  }
  return files
}

async function hashFile(filePath) {
  const content = await readFile(filePath)
  return {
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

async function fingerprintFiles(root, relativePaths) {
  const hash = createHash('sha256')
  for (const relativePath of [...relativePaths].sort()) {
    const fileHash = await hashFile(path.join(root, relativePath))
    hash.update(relativePath)
    hash.update('\0')
    hash.update(String(fileHash.bytes))
    hash.update('\0')
    hash.update(fileHash.sha256)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function collectPackageBuildInputs(root, packageDir) {
  const inputs = []
  for (const relativePath of ROOT_BUILD_INPUTS) {
    if (await isFile(path.join(root, relativePath))) inputs.push(relativePath)
  }

  const packageEntries = await readdir(path.join(root, packageDir), {
    withFileTypes: true,
  })
  for (const entry of packageEntries) {
    if (!entry.isFile()) continue
    const isTsconfig = entry.name === 'tsconfig.json'
      || (entry.name.startsWith('tsconfig.') && entry.name.endsWith('.json'))
    if (
      entry.name === 'package.json'
      || isTsconfig
      || /^tsup\.config\.[cm]?[jt]s$/.test(entry.name)
    ) {
      inputs.push(toPosix(path.join(packageDir, entry.name)))
    }
  }
  inputs.push(...await collectTreeFiles(root, path.join(packageDir, 'src'), {
    optional: true,
  }))
  return [...new Set(inputs)].sort()
}

async function collectArtifacts(root, packageDir) {
  const distDir = toPosix(path.join(packageDir, 'dist'))
  const manifestPath = toPosix(path.join(distDir, BUILD_ARTIFACT_MANIFEST))
  const files = await collectTreeFiles(root, distDir, {
    exclude: new Set([manifestPath]),
  })
  const artifacts = []
  for (const workspacePath of files) {
    const relativePath = toPosix(path.relative(path.join(packageDir, 'dist'), workspacePath))
    artifacts.push({
      path: relativePath,
      ...await hashFile(path.join(root, workspacePath)),
    })
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path))
}

function artifactFingerprint(artifacts) {
  const hash = createHash('sha256')
  for (const artifact of artifacts) {
    hash.update(artifact.path)
    hash.update('\0')
    hash.update(String(artifact.bytes))
    hash.update('\0')
    hash.update(artifact.sha256)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function packageMetadata(root, packageDir) {
  const packageJson = JSON.parse(
    await readFile(path.join(root, packageDir, 'package.json'), 'utf8'),
  )
  if (typeof packageJson.name !== 'string' || !packageJson.name) {
    throw new Error(`${toPosix(packageDir)}/package.json must declare a package name`)
  }
  return packageJson
}

export async function listBuildPackageDirs(root) {
  const packagesRoot = path.join(root, 'packages')
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const packageDirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packageDir = toPosix(path.join('packages', entry.name))
    const packageJsonPath = path.join(root, packageDir, 'package.json')
    if (!(await isFile(packageJsonPath))) continue
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    if (typeof packageJson.scripts?.build === 'string') packageDirs.push(packageDir)
  }
  return packageDirs.sort()
}

export function packageDirFromCwd(root, cwd) {
  const relativePath = toPosix(path.relative(root, cwd))
  if (
    path.isAbsolute(relativePath)
    || relativePath.startsWith('../')
    || !/^packages\/[^/]+$/.test(relativePath)
  ) {
    throw new Error('Run this package command from a direct packages/* workspace')
  }
  return relativePath
}

export async function captureBuildInputSnapshot({ root, packageDir }) {
  const packageJson = await packageMetadata(root, packageDir)
  const inputs = await collectPackageBuildInputs(root, packageDir)
  const snapshot = {
    schemaVersion: BUILD_ARTIFACT_SCHEMA_VERSION,
    packageName: packageJson.name,
    inputFileCount: inputs.length,
    inputFingerprint: await fingerprintFiles(root, inputs),
  }
  const turboDir = path.join(root, packageDir, '.turbo')
  await mkdir(turboDir, { recursive: true })
  const snapshotPath = path.join(turboDir, BUILD_INPUT_SNAPSHOT)
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  await rename(temporaryPath, snapshotPath)
  return snapshot
}

export async function readBuildInputSnapshot({ root, packageDir }) {
  const snapshotPath = path.join(root, packageDir, '.turbo', BUILD_INPUT_SNAPSHOT)
  let snapshot
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('build input snapshot is missing; run the prepare step first')
    }
    throw new Error('build input snapshot is unreadable')
  }
  const packageJson = await packageMetadata(root, packageDir)
  if (
    snapshot.schemaVersion !== BUILD_ARTIFACT_SCHEMA_VERSION
    || snapshot.packageName !== packageJson.name
    || !Number.isInteger(snapshot.inputFileCount)
    || typeof snapshot.inputFingerprint !== 'string'
  ) {
    throw new Error(`${packageJson.name} build input snapshot is invalid`)
  }
  return snapshot
}

export async function clearBuildInputSnapshot({ root, packageDir }) {
  await rm(path.join(root, packageDir, '.turbo', BUILD_INPUT_SNAPSHOT), {
    force: true,
  })
}

export async function writeBuildArtifactManifest({
  root,
  packageDir,
  expectedInputs,
}) {
  const packageJson = await packageMetadata(root, packageDir)
  const inputs = await collectPackageBuildInputs(root, packageDir)
  const artifacts = await collectArtifacts(root, packageDir)
  if (artifacts.length === 0) {
    throw new Error(`${packageJson.name} produced no dist artifacts`)
  }

  const inputFingerprint = await fingerprintFiles(root, inputs)
  if (
    expectedInputs
    && (
      expectedInputs.inputFileCount !== inputs.length
      || expectedInputs.inputFingerprint !== inputFingerprint
    )
  ) {
    throw new Error(`${packageJson.name} source inputs changed during build`)
  }
  const manifest = {
    schemaVersion: BUILD_ARTIFACT_SCHEMA_VERSION,
    packageName: packageJson.name,
    inputFileCount: inputs.length,
    inputFingerprint,
    artifactFingerprint: artifactFingerprint(artifacts),
    artifacts,
  }
  const distDir = path.join(root, packageDir, 'dist')
  await mkdir(distDir, { recursive: true })
  const manifestPath = path.join(distDir, BUILD_ARTIFACT_MANIFEST)
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temporaryPath, manifestPath)
  return manifest
}

function validArtifactPath(artifactPath) {
  return typeof artifactPath === 'string'
    && artifactPath.length > 0
    && !path.isAbsolute(artifactPath)
    && !artifactPath.includes('\\')
    && !artifactPath.split('/').includes('..')
    && path.posix.normalize(artifactPath) === artifactPath
}

export async function verifyBuildArtifactManifest({ root, packageDir }) {
  const messages = []
  const packageJson = await packageMetadata(root, packageDir)
  const manifestRelativePath = toPosix(
    path.join(packageDir, 'dist', BUILD_ARTIFACT_MANIFEST),
  )
  let manifest
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, manifestRelativePath), 'utf8'),
    )
  } catch (error) {
    messages.push(
      error?.code === 'ENOENT'
        ? `${packageJson.name} is missing completion manifest ${manifestRelativePath}`
        : `${packageJson.name} has an unreadable completion manifest`,
    )
    return { ok: false, messages }
  }

  if (manifest.schemaVersion !== BUILD_ARTIFACT_SCHEMA_VERSION) {
    messages.push(`${packageJson.name} has unsupported artifact manifest schema`)
  }
  if (manifest.packageName !== packageJson.name) {
    messages.push(`${packageJson.name} artifact manifest belongs to another package`)
  }
  if (!Array.isArray(manifest.artifacts)) {
    messages.push(`${packageJson.name} artifact manifest has no artifact inventory`)
    return { ok: false, messages }
  }

  const expected = new Map()
  for (const artifact of manifest.artifacts) {
    if (!validArtifactPath(artifact?.path)) {
      messages.push(`${packageJson.name} artifact manifest contains an unsafe path`)
      continue
    }
    if (expected.has(artifact.path)) {
      messages.push(`${packageJson.name} artifact manifest repeats ${artifact.path}`)
      continue
    }
    expected.set(artifact.path, artifact)
  }

  let actualArtifacts = []
  try {
    actualArtifacts = await collectArtifacts(root, packageDir)
  } catch (error) {
    messages.push(`${packageJson.name} artifact inventory is unreadable: ${error.message}`)
    return { ok: false, messages }
  }
  const actual = new Map(actualArtifacts.map((artifact) => [artifact.path, artifact]))
  for (const [artifactPath, expectedArtifact] of expected) {
    const actualArtifact = actual.get(artifactPath)
    if (!actualArtifact) {
      messages.push(`${packageJson.name} artifact is missing: dist/${artifactPath}`)
    } else if (
      actualArtifact.bytes !== expectedArtifact.bytes
      || actualArtifact.sha256 !== expectedArtifact.sha256
    ) {
      messages.push(`${packageJson.name} artifact changed after build: dist/${artifactPath}`)
    }
  }
  for (const artifactPath of actual.keys()) {
    if (!expected.has(artifactPath)) {
      messages.push(`${packageJson.name} has an unmanifested artifact: dist/${artifactPath}`)
    }
  }

  if (manifest.artifactFingerprint !== artifactFingerprint(manifest.artifacts)) {
    messages.push(`${packageJson.name} artifact manifest fingerprint is invalid`)
  }
  const inputs = await collectPackageBuildInputs(root, packageDir)
  const currentInputFingerprint = await fingerprintFiles(root, inputs)
  if (
    manifest.inputFileCount !== inputs.length
    || manifest.inputFingerprint !== currentInputFingerprint
  ) {
    messages.push(`${packageJson.name} dist was built from stale package inputs`)
  }

  return { ok: messages.length === 0, messages, manifest }
}
