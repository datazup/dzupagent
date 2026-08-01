import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  captureBuildInputSnapshot,
  packageDirFromCwd,
} from './build-artifact-integrity.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function prepareCurrentPackageBuild(cwd = process.cwd()) {
  const packageDir = packageDirFromCwd(repoRoot, cwd)
  return captureBuildInputSnapshot({ root: repoRoot, packageDir })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareCurrentPackageBuild()
}
