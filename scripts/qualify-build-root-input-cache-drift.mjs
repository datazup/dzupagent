import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { ROOT_BUILD_INPUTS } from './build-artifact-integrity.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const GOVERNED_ROOT_CACHE_INPUTS = Object.freeze([
  '.yarnrc.yml',
  'package.json',
  'turbo.json',
  'tsconfig.json',
  'yarn.lock',
])

export const REPORT_TYPE = 'dzupagent-build-root-input-cache-drift-report/v1'
export const DEFAULT_PACKAGE = '@dzupagent/memory'
export const DEFAULT_TASK = '@dzupagent/memory#build'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function governedRootCacheInputs(rootInputs = ROOT_BUILD_INPUTS) {
  const selected = GOVERNED_ROOT_CACHE_INPUTS.filter((input) => rootInputs.includes(input))
  if (
    selected.length !== GOVERNED_ROOT_CACHE_INPUTS.length
    || selected.some((input, index) => input !== GOVERNED_ROOT_CACHE_INPUTS[index])
  ) {
    throw new Error('root input drift campaign is not bound to every governed root cache input')
  }
  return selected
}

export function driftedRootInputBytes(inputPath, originalBytes) {
  if (!GOVERNED_ROOT_CACHE_INPUTS.includes(inputPath)) {
    throw new Error(`unsupported governed root cache input: ${inputPath}`)
  }
  const suffix = inputPath.endsWith('.json')
    ? '\n '
    : '\n# dzupagent root-input cache-drift qualification\n'
  const drifted = Buffer.concat([Buffer.from(originalBytes), Buffer.from(suffix)])
  if (drifted.equals(originalBytes)) throw new Error(`${inputPath} drift mutation was a no-op`)
  if (inputPath.endsWith('.json')) JSON.parse(drifted.toString('utf8'))
  return drifted
}

export function dryRunIdentity(dryRun, { inputPath, taskId }) {
  const globalFileHash = dryRun?.globalCacheInputs?.files?.[inputPath]
  const task = dryRun?.tasks?.find((candidate) => candidate.taskId === taskId)
  if (typeof globalFileHash !== 'string' || !globalFileHash) {
    throw new Error(`Turbo dry run omitted governed global input ${inputPath}`)
  }
  if (typeof task?.hash !== 'string' || !task.hash) {
    throw new Error(`Turbo dry run omitted target task ${taskId}`)
  }
  return Object.freeze({ globalFileHash, taskHash: task.hash })
}

export function assertDrift(inputPath, baseline, drifted) {
  if (baseline.globalFileHash === drifted.globalFileHash) {
    throw new Error(`${inputPath} content drift did not change Turbo's global file identity`)
  }
  if (baseline.taskHash === drifted.taskHash) {
    throw new Error(`${inputPath} content drift did not invalidate the target build task hash`)
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    throw new Error(`${path.basename(command)} failed${output ? `\n${output}` : ''}`)
  }
}

async function copyCandidateRootInputs(sourceRoot, mirrorRoot, rootInputs) {
  for (const relativePath of rootInputs) {
    const destination = path.join(mirrorRoot, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(sourceRoot, relativePath), destination)
  }
}

async function captureBytes(root, relativePaths) {
  const captured = new Map()
  for (const relativePath of relativePaths) {
    captured.set(relativePath, await readFile(path.join(root, relativePath)))
  }
  return captured
}

async function restoreBytes(root, captured) {
  for (const [relativePath, bytes] of captured) {
    await writeFile(path.join(root, relativePath), bytes)
  }
}

async function assertRestored(root, captured, label) {
  for (const [relativePath, bytes] of captured) {
    const current = await readFile(path.join(root, relativePath))
    if (!current.equals(bytes)) throw new Error(`${label} did not restore ${relativePath}`)
  }
}

async function turboDryRun({ mirrorRoot, packageName, turboBinary }) {
  const { stdout } = await run(turboBinary, [
    'run',
    'build',
    `--filter=${packageName}`,
    '--dry=json',
  ], { cwd: mirrorRoot })
  return JSON.parse(stdout)
}

export async function qualifyBuildRootInputCacheDrift(options = {}) {
  const sourceRoot = path.resolve(options.repoRoot ?? repoRoot)
  const packageName = options.packageName ?? DEFAULT_PACKAGE
  const taskId = options.taskId ?? DEFAULT_TASK
  const rootInputs = governedRootCacheInputs(options.rootBuildInputs ?? ROOT_BUILD_INPUTS)
  const allRootInputs = [...(options.rootBuildInputs ?? ROOT_BUILD_INPUTS)]
  const turboBinary = path.join(sourceRoot, 'node_modules', '.bin', 'turbo')
  const custodyRoot = await mkdtemp(path.join(tmpdir(), 'dzupagent-root-input-drift-'))
  const mirrorRoot = path.join(custodyRoot, 'mirror')
  let worktreeAdded = false

  const [{ stdout: sourceCommitOutput }, { stdout: sourceStatus }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }),
    run('git', ['status', '--porcelain=v1'], { cwd: sourceRoot }),
  ])

  try {
    await run('git', ['worktree', 'add', '--detach', mirrorRoot, 'HEAD'], { cwd: sourceRoot })
    worktreeAdded = true
    const committedBytes = await captureBytes(mirrorRoot, allRootInputs)
    await copyCandidateRootInputs(sourceRoot, mirrorRoot, allRootInputs)
    const candidateBytes = await captureBytes(mirrorRoot, rootInputs)

    const baselineDryRun = await turboDryRun({ mirrorRoot, packageName, turboBinary })
    const baselineIdentities = Object.fromEntries(rootInputs.map((inputPath) => [
      inputPath,
      dryRunIdentity(baselineDryRun, { inputPath, taskId }),
    ]))
    const cases = []

    for (const inputPath of rootInputs) {
      const inputFile = path.join(mirrorRoot, inputPath)
      const originalBytes = candidateBytes.get(inputPath)
      try {
        await writeFile(inputFile, driftedRootInputBytes(inputPath, originalBytes))
        const driftedDryRun = await turboDryRun({ mirrorRoot, packageName, turboBinary })
        const driftedIdentity = dryRunIdentity(driftedDryRun, { inputPath, taskId })
        assertDrift(inputPath, baselineIdentities[inputPath], driftedIdentity)
        cases.push(Object.freeze({
          inputPath,
          baselineFileHash: baselineIdentities[inputPath].globalFileHash,
          driftedFileHash: driftedIdentity.globalFileHash,
          baselineTaskHash: baselineIdentities[inputPath].taskHash,
          driftedTaskHash: driftedIdentity.taskHash,
          restored: true,
        }))
      } finally {
        await writeFile(inputFile, originalBytes)
        await assertRestored(mirrorRoot, new Map([[inputPath, originalBytes]]), 'case cleanup')
      }
    }

    const restoredDryRun = await turboDryRun({ mirrorRoot, packageName, turboBinary })
    const restoredTask = dryRunIdentity(restoredDryRun, {
      inputPath: rootInputs[0],
      taskId,
    }).taskHash
    if (restoredTask !== baselineIdentities[rootInputs[0]].taskHash) {
      throw new Error('restored mirror did not reproduce the baseline target task hash')
    }

    await restoreBytes(mirrorRoot, committedBytes)
    await assertRestored(mirrorRoot, committedBytes, 'worktree cleanup')
    const { stdout: mirrorStatus } = await run('git', ['status', '--porcelain=v1'], {
      cwd: mirrorRoot,
    })
    if (mirrorStatus.trim()) throw new Error('qualification mirror remained dirty after restoration')

    await run('git', ['worktree', 'remove', mirrorRoot], { cwd: sourceRoot })
    worktreeAdded = false
    await rm(custodyRoot, { recursive: true, force: true })

    return Object.freeze({
      schemaVersion: 1,
      artifactType: REPORT_TYPE,
      source: Object.freeze({
        commit: sourceCommitOutput.trim(),
        dirty: Boolean(sourceStatus.trim()),
        dirtyStatusSha256: sha256(Buffer.from(sourceStatus)),
      }),
      packageName,
      taskId,
      providerMode: 'disabled',
      providerCalls: 0,
      summary: Object.freeze({
        inputsQualified: cases.length,
        taskInvalidationsObserved: cases.length,
        mirrorRestored: true,
        mirrorRemoved: true,
      }),
      cases: Object.freeze(cases),
      authority: Object.freeze({
        effect: 'none',
        grants: Object.freeze([]),
        denies: Object.freeze([
          'provider-dispatch',
          'provider-spend',
          'repository-commit',
          'canonical-integration',
          'publication',
          'deployment',
          'production-activation',
        ]),
      }),
    })
  } finally {
    if (worktreeAdded) {
      try {
        await run('git', ['worktree', 'remove', '--force', mirrorRoot], { cwd: sourceRoot })
        worktreeAdded = false
      } catch {
        // Preserve the original qualification failure. The retained Git worktree
        // remains visible to `git worktree list` for explicit operator recovery.
      }
    }
    if (!worktreeAdded) await rm(custodyRoot, { recursive: true, force: true })
  }
}

function parseArgs(args) {
  const packageArg = args.find((arg) => arg.startsWith('--package='))
  const taskArg = args.find((arg) => arg.startsWith('--task='))
  return {
    packageName: packageArg?.slice('--package='.length) || DEFAULT_PACKAGE,
    taskId: taskArg?.slice('--task='.length) || DEFAULT_TASK,
    json: args.includes('--json'),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const report = await qualifyBuildRootInputCacheDrift(options)
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(
        `build-root-input-cache-drift: ok (${report.summary.inputsQualified} inputs, `
          + `${report.taskId}, mirror restored and removed)`,
      )
    }
  } catch (error) {
    console.error(`build-root-input-cache-drift: ${error.message}`)
    process.exitCode = 1
  }
}
