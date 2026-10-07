#!/usr/bin/env node
/**
 * dzupagent-run — run one `dzupflow/v2` document on the inactive provider-free
 * local host.
 *
 *   dzupagent-run <flow.yaml> --config <run.json> [--max-steps <n>]
 *
 * Prints the host receipt as JSON on stdout. Every step is checkpointed under
 * `checkpointDirectory`; re-running the same `runId` resumes without replaying
 * a completed step. Diagnostics are `{ ok: false, errors }` JSON on stderr.
 *
 * Exit codes: 0 when the receipt status is `completed` or `suspended`, 1 on
 * any argument, config, compile or host error and on any other status.
 */
import { runDzupagentRunCli } from '../src/run-v2-local.js'

runDzupagentRunCli(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        errors: [
          {
            code: 'DZUPAGENT_RUN_FATAL',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      })}\n`,
    )
    process.exitCode = 1
  })
