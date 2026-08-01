import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runTypecheck(packageName) {
  return new Promise((resolve, reject) => {
    const child = spawn('yarn', [
      'typecheck',
      `--filter=${packageName}`,
      '--force',
      '--concurrency=4',
      '--output-logs=hash-only',
    ], {
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
) {
  await Promise.all([
    runTypecheck(packageName),
    runTypecheck(packageName),
  ])
  return { packageName, runCount: 2 }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packageArg = process.argv.slice(2).find((arg) => arg.startsWith('--package='))
  const packageName = packageArg?.slice('--package='.length) || '@dzupagent/evals'
  try {
    const result = await rehearseConcurrentBuildCustody(packageName)
    console.log(
      `build-custody-rehearsal: ok (${result.runCount} concurrent `
        + `${result.packageName} graphs)`,
    )
  } catch (error) {
    console.error(`build-custody-rehearsal: ${error.message}`)
    process.exitCode = 1
  }
}
