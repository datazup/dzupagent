import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'

import { TEST_QUALITY_BASELINE_COUNTS } from '../eslint.baseline.js'
import {
  baselineWarningBudget,
  collectTestQualityCounts,
  diffTestQualityCounts,
} from './test-quality-baseline.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `--max-warnings=baseline` resolves to the number of violations eslint.baseline.js
 * already records for this package, so the budget shrinks automatically as the
 * baseline shrinks and never has to be hand-maintained per package.
 */
export const BASELINE_WARNING_BUDGET = 'baseline'

export function parseLintArguments(args) {
  let fix = false
  let quiet = false
  let maxWarnings = Number.POSITIVE_INFINITY
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--fix') fix = true
    else if (arg === '--quiet') quiet = true
    else if (arg.startsWith('--max-warnings=')) {
      maxWarnings = parseMaxWarnings(arg.slice('--max-warnings='.length))
    } else if (arg === '--max-warnings') {
      maxWarnings = parseMaxWarnings(args[++index])
    } else {
      throw new Error(`Unsupported package lint argument: ${arg}`)
    }
  }
  if (
    maxWarnings !== BASELINE_WARNING_BUDGET
    && !Number.isInteger(maxWarnings)
    && maxWarnings !== Number.POSITIVE_INFINITY
  ) {
    throw new Error('--max-warnings must be an integer or "baseline"')
  }
  return { fix, quiet, maxWarnings }
}

function parseMaxWarnings(raw) {
  return raw === BASELINE_WARNING_BUDGET ? BASELINE_WARNING_BUDGET : Number(raw)
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

/** Repo-relative package prefix (`packages/memory/`) used to scope the baseline. */
export function packageBaselineScope(root, cwd) {
  packageLintTarget(root, cwd)
  return `${path.relative(root, cwd).split(path.sep).join('/')}/`
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

  // Measured before --quiet drops warnings from `results`: the baseline ceiling
  // is about warnings, so it has to read them even when they are not printed.
  const scope = packageBaselineScope(root, cwd)
  const measured = collectTestQualityCounts(results, { root })
  const measuredWarnings = collectTestQualityCounts(results, { root, severities: [1] })
  const { problems } = diffTestQualityCounts({
    observed: measured.counts,
    baseline: TEST_QUALITY_BASELINE_COUNTS,
    scope,
    lintedFiles: measured.lintedFiles,
  })
  for (const item of measured.unclassified) {
    problems.push({
      kind: 'unclassified-rule',
      file: item.file,
      message:
        `${item.file}: no-restricted-syntax message matches no rule id in `
        + `scripts/test-quality-baseline.mjs — "${item.message.slice(0, 80)}...". `
        + 'Register the rule there so it stays under the baseline ceiling.',
    })
  }

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
  if (problems.length > 0) {
    process.stdout.write(
      `\nTest-quality baseline (eslint.baseline.js) violated — ${problems.length} problem(s):\n`
      + problems.map((problem) => `  ${problem.message}`).join('\n')
      + '\n',
    )
  }

  const errorCount = results.reduce((total, result) => total + result.errorCount, 0)
  const warningCount = results.reduce((total, result) => total + result.warningCount, 0)

  // `--max-warnings=baseline` caps the three grandfathered test-quality rules at
  // exactly what eslint.baseline.js records for this package. It is an aggregate
  // backstop behind the per-file ceiling above; the other `warn`-severity rules
  // (security/*) are deliberately not capped here — they were never baselined.
  const budgetedWarnings = options.maxWarnings === BASELINE_WARNING_BUDGET
    ? baselineWarningBudget(measuredWarnings.counts, scope)
    : warningCount
  const maxWarnings = options.maxWarnings === BASELINE_WARNING_BUDGET
    ? baselineWarningBudget(TEST_QUALITY_BASELINE_COUNTS, scope)
    : options.maxWarnings
  if (budgetedWarnings > maxWarnings) {
    process.stdout.write(
      `\n${budgetedWarnings} test-quality warnings exceed the --max-warnings budget of ${maxWarnings}.\n`,
    )
  }
  return errorCount > 0 || budgetedWarnings > maxWarnings || problems.length > 0 ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPackageLint()
}
