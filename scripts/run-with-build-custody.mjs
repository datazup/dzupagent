import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  BUILD_CUSTODY_TOKEN_ENV,
  withBuildCustody,
} from './build-custody.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseCommand(args) {
  if (args[0] === '--shell') {
    if (args.length !== 2 || !args[1]) {
      throw new Error('--shell requires exactly one command string')
    }
    return { command: args[1], args: [], shell: true }
  }
  if (!args[0]) throw new Error('a command is required after run-with-build-custody.mjs')
  return { command: args[0], args: args.slice(1), shell: false }
}

function runChild(command, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [BUILD_CUSTODY_TOKEN_ENV]: token,
      },
      shell: command.shell,
      stdio: 'inherit',
    })
    const forwardInterrupt = () => {
      if (!child.killed) child.kill('SIGINT')
    }
    const forwardTermination = () => {
      if (!child.killed) child.kill('SIGTERM')
    }
    process.once('SIGINT', forwardInterrupt)
    process.once('SIGTERM', forwardTermination)
    const cleanup = () => {
      process.off('SIGINT', forwardInterrupt)
      process.off('SIGTERM', forwardTermination)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : (code ?? 1))
    })
  })
}

export async function runWithBuildCustody(args = process.argv.slice(2)) {
  const command = parseCommand(args)
  return withBuildCustody({
    root: repoRoot,
    run: async ({ token }) => runChild(command, token),
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runWithBuildCustody()
  } catch (error) {
    console.error(`build-custody: ${error.message}`)
    process.exitCode = 1
  }
}
