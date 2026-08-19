import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import lockfile from 'proper-lockfile'

export const BUILD_CUSTODY_SCHEMA_VERSION = 2
export const BUILD_CUSTODY_TOKEN_ENV = 'DZUP_BUILD_CUSTODY_TOKEN'

const LOCK_TARGET = 'build-custody'
const OWNER_FILE = 'build-custody-owner.json'

// A build graph holding custody can be starved for far longer than it takes to
// run: sampling the lock mtime on a loaded host recorded heartbeat gaps of
// 10.1s, 17.6s, 17.8s, 30.1s and 26.8s against the previous 30s window. Any
// gap past `stale` lets a competing invocation declare a *live* holder dead and
// steal custody, after which two graphs write `dist/` at once. Time is a bad
// liveness signal here, so the window is set well past the observed starvation
// ceiling and genuine abandonment is detected from the owner process instead
// (see `reclaimAbandonedCustody`).
const CUSTODY_LOCK_OPTIONS = {
  realpath: false,
  stale: 180_000,
  update: 10_000,
}

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

/**
 * Read the kernel's start time for `pid` (field 22 of /proc/<pid>/stat, in
 * clock ticks since boot). A pid alone is not an identity: pids are reused, so
 * a recovery path keyed on the pid can attach to an unrelated process. The
 * (pid, startTicks) pair is unique for the lifetime of a boot.
 *
 * The `comm` field can itself contain spaces and parentheses, so the fields are
 * counted from the last `)` rather than from the start of the line.
 */
export async function processStartTicks(pid) {
  if (process.platform !== 'linux') return undefined
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2)
    // Field 3 is `state`; `starttime` is field 22, i.e. index 19 from here.
    const ticks = Number(afterComm.split(' ')[19])
    return Number.isFinite(ticks) ? ticks : undefined
  } catch {
    return undefined
  }
}

/**
 * True when the recorded owner process is still the process that took custody.
 * A pid that has been recycled reads as *not* alive, which is the safe answer:
 * the original holder is gone and its custody is genuinely abandoned.
 */
export async function ownerProcessIsAlive(owner) {
  if (!Number.isInteger(owner?.pid)) return false
  const startTicks = await processStartTicks(owner.pid)
  if (startTicks !== undefined || Number.isInteger(owner.pidStartTicks)) {
    return startTicks !== undefined && startTicks === owner.pidStartTicks
  }
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
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
  const locked = await lockfile.check(lockTarget, CUSTODY_LOCK_OPTIONS)
  if (!locked || !validOwner(owner) || !sameToken(owner.token, token)) {
    throw new Error('inherited build custody is not owned by this build graph')
  }
  return owner
}

/**
 * Release a lock whose owner process is provably gone.
 *
 * With `stale` raised past the starvation ceiling, a crashed holder would
 * otherwise block every other build graph for three minutes. Liveness is a
 * sounder signal than mtime, so abandonment is established from the owner
 * record and the lock directory is removed directly. Two invocations can race
 * to reclaim; that is harmless, because the subsequent `lockfile.lock` is an
 * atomic mkdir and only one of them can win it.
 *
 * Returns true when a lock was actually reclaimed.
 */
async function reclaimAbandonedCustody({ lockTarget, ownerFile }) {
  const owner = await readOwner(ownerFile)
  if (!validOwner(owner)) return false
  if (await ownerProcessIsAlive(owner)) return false
  if (!await lockfile.check(lockTarget, CUSTODY_LOCK_OPTIONS)) return false
  process.stderr.write(
    `build-custody: reclaiming custody abandoned by dead pid ${owner.pid} `
    + `(acquired ${owner.acquiredAt})\n`,
  )
  await rm(`${lockTarget}.lock`, { recursive: true, force: true })
  await rm(ownerFile, { force: true })
  return true
}

/**
 * Fail loudly and immediately if custody is lost mid-build.
 *
 * proper-lockfile's default behaviour is an uncaught throw from a timer, which
 * surfaces as an unrelated-looking stack far from the build. Losing custody
 * means another graph is now writing the same `dist/`, so anything this process
 * emits from here on is untrustworthy: stop rather than produce artifacts that
 * look built.
 */
function onCustodyCompromised(error) {
  process.stderr.write(
    'build-custody: FATAL - custody was compromised while the build graph was '
    + `still running (${error?.message ?? error}).\n`
    + 'build-custody: another build graph may now be writing the same dist/ '
    + 'output. Aborting rather than emitting artifacts from an unowned build.\n',
  )
  process.exit(1)
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
  // `processDescendsFrom` alone keys the inheritance decision on a pid, which
  // a recycled pid could satisfy by coincidence; require the recorded process
  // identity to still match before adopting someone else's custody.
  if (
    validOwner(activeOwner)
    && await ownerProcessIsAlive(activeOwner)
    && await processDescendsFrom(activeOwner.pid)
    && await lockfile.check(lockTarget, CUSTODY_LOCK_OPTIONS)
  ) {
    return {
      inherited: true,
      owner: activeOwner,
      token: activeOwner.token,
      release: async () => {},
    }
  }
  await reclaimAbandonedCustody({ lockTarget, ownerFile })
  const alreadyLocked = await lockfile.check(lockTarget, CUSTODY_LOCK_OPTIONS)
  if (alreadyLocked) {
    process.stderr.write('build-custody: waiting for the active build graph\n')
  }

  const releaseLock = await lockfile.lock(lockTarget, {
    ...CUSTODY_LOCK_OPTIONS,
    onCompromised: onCustodyCompromised,
    retries: {
      retries,
      factor: 1,
      minTimeout: retryDelayMs,
      maxTimeout: retryDelayMs,
      randomize: true,
    },
  })
  const token = randomUUID()
  const startTicks = await processStartTicks(process.pid)
  const owner = {
    schemaVersion: BUILD_CUSTODY_SCHEMA_VERSION,
    token,
    pid: process.pid,
    ...(startTicks === undefined ? {} : { pidStartTicks: startTicks }),
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
