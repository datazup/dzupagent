import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  listBuildPackageDirs,
  packageDirFromCwd,
  verifyBuildArtifactManifest,
} from './build-artifact-integrity.mjs'
import { checkPackageExportArtifacts } from './check-package-export-artifacts.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function normalizePackageDir(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  return normalized.startsWith('packages/') ? normalized : `packages/${normalized}`
}

export async function checkBuildArtifactIntegrity({ root = repoRoot, packageDirs } = {}) {
  const selected = packageDirs?.length
    ? packageDirs.map(normalizePackageDir).sort()
    : await listBuildPackageDirs(root)
  const messages = []
  for (const packageDir of selected) {
    const result = await verifyBuildArtifactManifest({ root, packageDir })
    messages.push(...result.messages)
  }
  const exportResult = await checkPackageExportArtifacts({
    root,
    packageDirs: selected,
  })
  messages.push(...exportResult.messages)
  return { ok: messages.length === 0, messages, packageDirs: selected }
}

async function main() {
  const args = process.argv.slice(2)
  const packageDirs = args.length > 0
    ? args
    : process.cwd() === repoRoot
      ? undefined
      : [packageDirFromCwd(repoRoot, process.cwd())]
  const result = await checkBuildArtifactIntegrity({ packageDirs })
  if (!result.ok) {
    for (const message of result.messages) {
      console.error(`build-artifact-integrity: ${message}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`build-artifact-integrity: ok (${result.packageDirs.length} packages)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
