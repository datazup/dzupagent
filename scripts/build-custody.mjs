import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import lockfile from 'proper-lockfile'

export const BUILD_CUSTODY_SCHEMA_VERSION = 1
export const BUILD_CUSTODY_TOKEN_ENV = 'DZUP_BUILD_CUSTODY_TOKEN'

const LOCK_TARGET = 'build-custody'
const OWNER_FILE = 'build-custody-owner.json'

function custodyPaths(root) {
  const turboDir = path.join(root, '.turbo')
  return {
    turboDir,
    lockTarget: path.join(turboDir, LOCK_TARGET),
    ownerFile: path.join(turboDir, OWNER_FILE),
  }
}

async function writeOwner(ownerFile, owner) {
  const temporaryPath = `${ownerFile}.${process.pid}.${owner.token}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporaryPath, ownerFile)
}

async function readOwner(ownerFile) {
  try {
    return JSON.parse(await readFile(ownerFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error('build custody owner record is unreadable')
  }
}

function validOwner(owner) {
  return owner?.schemaVersion === BUILD_CUSTODY_SCHEMA_VERSION
    && typeof owner.token === 'string'
    && owner.token.length > 0
    && Number.isInteger(owner.pid)
    && typeof owner.acquiredAt === 'string'
}

function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer)
}

async function parentPid(pid) {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const match = stat.match(/^\d+ \(.*\) \S+ (\d+) /)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

export async function processDescendsFrom(ancestorPid, pid = process.pid) {
  if (!Number.isInteger(ancestorPid) || ancestorPid <= 1 || ancestorPid === pid) {
    return false
  }
  let currentPid = pid
  for (let depth = 0; depth < 64 && currentPid > 1; depth += 1) {
    currentPid = await parentPid(currentPid)
    if (currentPid === ancestorPid) return true
    if (!currentPid) return false
  }
  return false
}

export async function validateBuildCustody({ root, token }) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('build custody token is missing')
  }
  const { lockTarget, ownerFile } = custodyPaths(root)
  const owner = await readOwner(ownerFile)
  const locked = await lockfile.check(lockTarget, { realpath: false })
  if (!locked || !validOwner(owner) || !sameToken(owner.token, token)) {
    throw new Error('inherited build custody is not owned by this build graph')
  }
  return owner
}

export async function acquireBuildCustody({
  root,
  retries = 7200,
  retryDelayMs = 100,
} = {}) {
  if (!root) throw new Error('build custody root is required')
  const inheritedToken = process.env[BUILD_CUSTODY_TOKEN_ENV]
  if (inheritedToken) {
    const owner = await validateBuildCustody({ root, token: inheritedToken })
    return {
      inherited: true,
      owner,
      token: inheritedToken,
      release: async () => {},
    }
  }

  const { turboDir, lockTarget, ownerFile } = custodyPaths(root)
  await mkdir(turboDir, { recursive: true })
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 })
  const activeOwner = await readOwner(ownerFile)
  if (
    validOwner(activeOwner)
    && await processDescendsFrom(activeOwner.pid)
    && await lockfile.check(lockTarget, { realpath: false })
  ) {
    return {
      inherited: true,
      owner: activeOwner,
      token: activeOwner.token,
      release: async () => {},
    }
  }
  const alreadyLocked = await lockfile.check(lockTarget, { realpath: false })
  if (alreadyLocked) {
    process.stderr.write('build-custody: waiting for the active build graph\n')
  }

  const releaseLock = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries,
      factor: 1,
      minTimeout: retryDelayMs,
      maxTimeout: retryDelayMs,
      randomize: true,
    },
  })
  const token = randomUUID()
  const owner = {
    schemaVersion: BUILD_CUSTODY_SCHEMA_VERSION,
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }

  try {
    await writeOwner(ownerFile, owner)
  } catch (error) {
    await releaseLock()
    throw error
  }

  let released = false
  return {
    inherited: false,
    owner,
    token,
    release: async () => {
      if (released) return
      released = true
      const currentOwner = await readOwner(ownerFile)
      if (sameToken(currentOwner?.token, token)) {
        await rm(ownerFile, { force: true })
      }
      await releaseLock()
    },
  }
}

export async function withBuildCustody({ root, run }) {
  const custody = await acquireBuildCustody({ root })
  try {
    return await run(custody)
  } finally {
    await custody.release()
  }
}
