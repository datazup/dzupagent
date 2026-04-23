import { join } from 'node:path'

/**
 * Returns the canonical run-log directory for a given project and run.
 * Both RunEventStore and replay endpoints must use this helper so the
 * path contract never drifts between producer and consumer.
 *
 * Layout: <projectDir>/.dzupagent/runs/<runId>/
 */
export function runLogRoot(projectDir: string, runId: string): string {
  return join(projectDir, '.dzupagent', 'runs', runId)
}
