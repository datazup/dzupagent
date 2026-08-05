import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  BUILD_CUSTODY_TOKEN_ENV,
  withBuildCustody,
} from './build-custody.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Split argv into the child command to run under build custody.
 *
 * `--shell "<cmd>"` runs one string through a shell. Any arguments *after* that
 * string are appended to it rather than rejected: yarn appends user flags to the
 * script it runs, so `yarn workspace <pkg> run build --filter=x` arrives here as
 * `['--shell', '<cmd>', '--filter=x']`. Requiring exactly two args made every
 * package-level `build` script (40+ of them use `--shell`) fail with
 * "--shell requires exactly one command string" the moment any flag was passed —
 * including the flags people reach for when a build misbehaves.
 *
 * Appended args are quoted so a path containing spaces cannot split into two
 * words, and so they cannot inject additional shell commands.
 */
export function parseCommand(args) {
  if (args[0] === '--shell') {
    const [, script, ...rest] = args
    if (!script) {
      throw new Error('--shell requires exactly one command string')
    }
    const command = rest.length > 0
      ? `${script} ${rest.map(quoteShellArg).join(' ')}`
      : script
    return { command, args: [], shell: true }
  }
  if (!args[0]) throw new Error('a command is required after run-with-build-custody.mjs')
  return { command: args[0], args: args.slice(1), shell: false }
}

/**
 * Single-quote an argument for POSIX `sh`, escaping any embedded single quotes.
 * Without this, an appended argument could terminate the command and start a new
 * one, turning a build flag into arbitrary shell execution.
 */
function quoteShellArg(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
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
