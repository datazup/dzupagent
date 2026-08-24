import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = path.join(packageRoot, 'dist')

if (path.basename(packageRoot) !== 'memory' || path.basename(path.dirname(packageRoot)) !== 'packages') {
  throw new Error('Refusing to clean a directory outside packages/memory')
}

await rm(dist, { recursive: true, force: true })
