import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  packageDirFromCwd,
  writeBuildArtifactManifest,
} from './build-artifact-integrity.mjs'
import { checkPackageExportArtifacts } from './check-package-export-artifacts.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function writeCurrentPackageManifest(cwd = process.cwd()) {
  const packageDir = packageDirFromCwd(repoRoot, cwd)
  const exportCheck = await checkPackageExportArtifacts({
    root: repoRoot,
    packageDirs: [packageDir],
  })
  if (!exportCheck.ok) throw new Error(exportCheck.messages.join('\n'))
  return {
    packageDir,
    manifest: await writeBuildArtifactManifest({ root: repoRoot, packageDir }),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await writeCurrentPackageManifest()
  console.log(
    `build-artifact-manifest: ${result.manifest.packageName} `
      + `${result.manifest.artifacts.length} files`,
  )
}
