import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_TASK_CONCURRENCY = 1

export function createTypecheckArgs(
  packageName,
  taskConcurrency = DEFAULT_TASK_CONCURRENCY,
) {
  if (!Number.isInteger(taskConcurrency) || taskConcurrency < 1) {
    throw new Error('task concurrency must be a positive integer')
  }
  return [
    'typecheck',
    `--filter=${packageName}`,
    '--force',
    `--concurrency=${taskConcurrency}`,
    '--output-logs=hash-only',
  ]
}

function runTypecheck(packageName, taskConcurrency) {
  return new Promise((resolve, reject) => {
    const child = spawn('yarn', createTypecheckArgs(packageName, taskConcurrency), {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else reject(new Error(
        `concurrent typecheck failed (${signal ?? code})\n`
          + output.replaceAll(repoRoot, '<repo>'),
      ))
    })
  })
}

export async function rehearseConcurrentBuildCustody(
  packageName = '@dzupagent/evals',
  {
    taskConcurrency = DEFAULT_TASK_CONCURRENCY,
    runGraph = runTypecheck,
  } = {},
) {
  // The concurrency being rehearsed is between two competing build graphs.
  // Keep each graph internally bounded: four tasks per graph exhausted the
  // 2-core GitHub runner before the custody assertion could complete.
  await Promise.all([
    runGraph(packageName, taskConcurrency),
    runGraph(packageName, taskConcurrency),
  ])
  return { packageName, runCount: 2, taskConcurrency }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packageArg = process.argv.slice(2).find((arg) => arg.startsWith('--package='))
  const concurrencyArg = process.argv.slice(2)
    .find((arg) => arg.startsWith('--task-concurrency='))
  const packageName = packageArg?.slice('--package='.length) || '@dzupagent/evals'
  const taskConcurrency = concurrencyArg
    ? Number(concurrencyArg.slice('--task-concurrency='.length))
    : DEFAULT_TASK_CONCURRENCY
  try {
    const result = await rehearseConcurrentBuildCustody(packageName, { taskConcurrency })
    console.log(
      `build-custody-rehearsal: ok (${result.runCount} concurrent `
        + `${result.packageName} graphs, ${result.taskConcurrency} task per graph)`,
    )
  } catch (error) {
    console.error(`build-custody-rehearsal: ${error.message}`)
    process.exitCode = 1
  }
}
