/**
 * CLI command: `forge scorecard`
 *
 * Generates and displays an integration scorecard for a DzupAgent server
 * configuration. Supports console, JSON, and markdown output formats.
 */
import { writeFileSync } from 'node:fs'
import type { ForgeServerConfig } from '../app.js'
import { IntegrationScorecard, type ScorecardProbeInput, type ScorecardReport } from '../scorecard/integration-scorecard.js'
import { ScorecardReporter, type ScorecardFormat } from '../scorecard/scorecard-reporter.js'

export interface ScorecardCommandOptions {
  /** Output format (default: 'console') */
  format?: ScorecardFormat
  /** Write output to a file instead of stdout */
  output?: string
  /** Extra probe inputs for deeper scoring */
  probe?: ScorecardProbeInput
  /** Root directory used for automated scorecard probe collection */
  probeRootDir?: string
  /** Environment used for automated scorecard probe collection */
  probeEnv?: NodeJS.ProcessEnv
  /** Disable automated filesystem/environment probe collection */
  autoCollectProbe?: boolean
}

export interface ScorecardCommandResult {
  report: ScorecardReport
  rendered: string
  writtenTo?: string
}

/**
 * Generate an integration scorecard from a ForgeServerConfig.
 *
 * This is the programmatic entry point. The CLI binary would parse argv
 * and call this function.
 */
export function runScorecard(
  config: ForgeServerConfig,
  options?: ScorecardCommandOptions,
): ScorecardCommandResult {
  const format = options?.format ?? 'console'
  const scorecard = new IntegrationScorecard(config, options?.probe, {
    autoCollectProbe: options?.autoCollectProbe,
    rootDir: options?.probeRootDir,
    env: options?.probeEnv,
  })
  const report = scorecard.generate()
  const reporter = new ScorecardReporter(report)
  const rendered = reporter.render(format)

  let writtenTo: string | undefined

  if (options?.output) {
    writeFileSync(options.output, rendered, 'utf-8')
    writtenTo = options.output
  }

  return { report, rendered, writtenTo }
}

/**
 * Parse CLI-style arguments into ScorecardCommandOptions.
 *
 * Recognises:
 *   --json            shorthand for --format json
 *   --format <fmt>    console | markdown | json
 *   --output <path>   write to file
 */
export function parseScorecardArgs(args: string[]): ScorecardCommandOptions {
  const options: ScorecardCommandOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      options.format = 'json'
    } else if (arg === '--markdown' || arg === '--md') {
      options.format = 'markdown'
    } else if (arg === '--format' && i + 1 < args.length) {
      i++
      const fmt = args[i] as ScorecardFormat | undefined
      if (fmt === 'console' || fmt === 'json' || fmt === 'markdown') {
        options.format = fmt
      }
    } else if ((arg === '--output' || arg === '-o') && i + 1 < args.length) {
      i++
      options.output = args[i]
    }
  }

  return options
}
