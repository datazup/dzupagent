/**
 * CI Monitor — detect CI failures and parse provider-specific status.
 */

export type CIProvider = 'github-actions' | 'gitlab-ci' | 'generic'

export interface CIStatus {
  provider: CIProvider
  runId: string
  branch: string
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled'
  /** Failed job names and their log excerpts */
  failures: CIFailure[]
  url?: string
  timestamp: Date
}

export interface CIFailure {
  jobName: string
  step?: string
  logExcerpt: string
  exitCode?: number
  errorCategory?: 'build' | 'test' | 'lint' | 'type-check' | 'deploy' | 'unknown'
}

export interface CIMonitorConfig {
  provider: CIProvider
  /** Polling interval in ms (default: 30_000) */
  pollIntervalMs?: number
  /** Max log lines to capture per failure (default: 100) */
  maxLogLines?: number
}

const CATEGORY_PATTERNS: Array<[RegExp, CIFailure['errorCategory']]> = [
  [/tsc|type\s*.*error|TS\d{4}/i, 'type-check'],
  [/FAIL|test\s*.*fail|vitest|jest/i, 'test'],
  [/eslint|lint\s*.*error/i, 'lint'],
  [/build\s*.*fail|compile\s*.*error/i, 'build'],
  [/deploy\s*.*fail/i, 'deploy'],
]

/**
 * Categorize a CI failure from log content.
 */
export function categorizeFailure(logExcerpt: string): CIFailure['errorCategory'] {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(logExcerpt)) {
      return category
    }
  }
  return 'unknown'
}

function toStatus(value: unknown): CIStatus['status'] {
  const str = String(value).toLowerCase()
  const map: Record<string, CIStatus['status']> = {
    queued: 'pending',
    in_progress: 'running',
    completed: 'success',
    success: 'success',
    failure: 'failure',
    cancelled: 'cancelled',
    action_required: 'pending',
  }
  return map[str] ?? 'pending'
}

/**
 * Parse GitHub Actions workflow run status from API response.
 * Expects the shape returned by GET /repos/{owner}/{repo}/actions/runs/{run_id}.
 */
export function parseGitHubActionsStatus(apiResponse: Record<string, unknown>): CIStatus {
  const conclusion = apiResponse['conclusion'] as string | null
  const ghStatus = apiResponse['status'] as string | undefined

  let status: CIStatus['status']
  if (conclusion === 'failure') {
    status = 'failure'
  } else if (conclusion === 'cancelled') {
    status = 'cancelled'
  } else if (conclusion === 'success') {
    status = 'success'
  } else {
    status = toStatus(ghStatus ?? 'pending')
  }

  const failures: CIFailure[] = []
  const jobs = apiResponse['jobs'] as Array<Record<string, unknown>> | undefined
  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      if (job['conclusion'] === 'failure') {
        const logExcerpt = typeof job['log'] === 'string' ? job['log'] : ''
        const failure: CIFailure = {
          jobName: String(job['name'] ?? 'unknown'),
          logExcerpt,
        }
        if (typeof job['step'] === 'string') failure.step = job['step']
        if (typeof job['exit_code'] === 'number') failure.exitCode = job['exit_code']
        const cat = categorizeFailure(logExcerpt)
        if (cat !== undefined) failure.errorCategory = cat
        failures.push(failure)
      }
    }
  }

  const result: CIStatus = {
    provider: 'github-actions',
    runId: String(apiResponse['id'] ?? ''),
    branch: String(apiResponse['head_branch'] ?? ''),
    status,
    failures,
    timestamp: new Date(typeof apiResponse['updated_at'] === 'string' ? apiResponse['updated_at'] : Date.now()),
  }
  if (typeof apiResponse['html_url'] === 'string') result.url = apiResponse['html_url']
  return result
}

/**
 * Parse generic CI webhook payload into CIStatus.
 */
export function parseCIWebhook(payload: Record<string, unknown>, provider: CIProvider): CIStatus {
  const failures: CIFailure[] = []
  const rawFailures = payload['failures'] as Array<Record<string, unknown>> | undefined
  if (Array.isArray(rawFailures)) {
    for (const f of rawFailures) {
      const logExcerpt = typeof f['log'] === 'string' ? f['log'] : typeof f['logExcerpt'] === 'string' ? f['logExcerpt'] : ''
      const entry: CIFailure = {
        jobName: String(f['jobName'] ?? f['job'] ?? 'unknown'),
        logExcerpt,
      }
      if (typeof f['step'] === 'string') entry.step = f['step']
      if (typeof f['exitCode'] === 'number') entry.exitCode = f['exitCode']
      const cat = categorizeFailure(logExcerpt)
      if (cat !== undefined) entry.errorCategory = cat
      failures.push(entry)
    }
  }

  const rawStatus = payload['status'] as string | undefined
  let status: CIStatus['status'] = toStatus(rawStatus ?? 'pending')
  if (failures.length > 0 && status === 'success') {
    status = 'failure'
  }

  const ciStatus: CIStatus = {
    provider,
    runId: String(payload['runId'] ?? payload['id'] ?? ''),
    branch: String(payload['branch'] ?? payload['ref'] ?? ''),
    status,
    failures,
    timestamp: new Date(typeof payload['timestamp'] === 'string' ? payload['timestamp'] : Date.now()),
  }
  if (typeof payload['url'] === 'string') ciStatus.url = payload['url']
  return ciStatus
}
