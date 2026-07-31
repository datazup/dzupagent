import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseLintArguments(args) {
  let fix = false
  let quiet = false
  let maxWarnings = Number.POSITIVE_INFINITY
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--fix') fix = true
    else if (arg === '--quiet') quiet = true
    else if (arg.startsWith('--max-warnings=')) {
      maxWarnings = Number(arg.slice('--max-warnings='.length))
    } else if (arg === '--max-warnings') {
      maxWarnings = Number(args[++index])
    } else {
      throw new Error(`Unsupported package lint argument: ${arg}`)
    }
  }
  if (!Number.isInteger(maxWarnings) && maxWarnings !== Number.POSITIVE_INFINITY) {
    throw new Error('--max-warnings must be an integer')
  }
  return { fix, quiet, maxWarnings }
}

export function packageLintTarget(root, cwd) {
  const relativePackageDir = path.relative(root, cwd)
  if (
    path.isAbsolute(relativePackageDir)
    || relativePackageDir.startsWith('..')
    || !/^packages[/\\][^/\\]+$/.test(relativePackageDir)
  ) {
    throw new Error('Run package lint from a direct packages/* workspace')
  }
  return 'src/'
}

export async function runPackageLint({
  root = repoRoot,
  cwd = process.cwd(),
  args = process.argv.slice(2),
} = {}) {
  const options = parseLintArguments(args)
  const target = packageLintTarget(root, cwd)
  const eslint = new ESLint({ cwd, fix: options.fix })
  let results = await eslint.lintFiles([target])
  if (options.fix) await ESLint.outputFixes(results)
  if (options.quiet) {
    results = results.map((result) => ({
      ...result,
      messages: result.messages.filter((message) => message.severity === 2),
      warningCount: 0,
      fixableWarningCount: 0,
    }))
  }
  const formatter = await eslint.loadFormatter('stylish')
  const output = await formatter.format(results)
  if (output) process.stdout.write(output)
  const errorCount = results.reduce((total, result) => total + result.errorCount, 0)
  const warningCount = results.reduce((total, result) => total + result.warningCount, 0)
  return errorCount > 0 || warningCount > options.maxWarnings ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPackageLint()
}
