/**
 * API contract validator — validates coherence between backend endpoint
 * definitions and frontend API calls in generated code.
 *
 * Pure functions, no external dependencies.
 */

export interface APIEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  file: string
  line: number
}

export interface APICall {
  method: string
  path: string
  file: string
  line: number
}

export interface ContractIssue {
  type: 'unmatched-call' | 'unmatched-endpoint' | 'method-mismatch'
  description: string
  file: string
  line: number
}

export interface ContractValidationResult {
  valid: boolean
  issues: ContractIssue[]
  endpoints: APIEndpoint[]
  calls: APICall[]
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// router.get('/path', ...) or app.post('/path', ...)
const ENDPOINT_RE = /(?:app|router|route)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi

// axios.get('/api/path') or api.post('/api/path')
const CLIENT_METHOD_RE = /(?:axios|api|http|client)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi

// fetch('/api/path') or fetch('/api/path', { method: 'POST' })
const FETCH_RE = /fetch\s*\(\s*['"]([^'"]+)['"]/g
const FETCH_METHOD_RE = /method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i

/**
 * Extract API endpoint definitions from backend code.
 * Matches patterns like: router.get('/path', ...), app.post('/path', ...)
 */
export function extractEndpoints(files: Record<string, string>): APIEndpoint[] {
  const endpoints: APIEndpoint[] = []

  for (const [filePath, content] of Object.entries(files)) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      ENDPOINT_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = ENDPOINT_RE.exec(line)) !== null) {
        const method = match[1]!.toUpperCase() as HttpMethod
        endpoints.push({ method, path: normalizePath(match[2]!), file: filePath, line: i + 1 })
      }
    }
  }

  return endpoints
}

/**
 * Extract API calls from frontend code.
 * Matches patterns like: fetch('/api/path'), axios.get('/api/path'), api.post(...)
 */
export function extractAPICalls(files: Record<string, string>): APICall[] {
  const calls: APICall[] = []

  for (const [filePath, content] of Object.entries(files)) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      // axios/api client method calls
      CLIENT_METHOD_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = CLIENT_METHOD_RE.exec(line)) !== null) {
        calls.push({
          method: match[1]!.toUpperCase(),
          path: normalizePath(match[2]!),
          file: filePath,
          line: i + 1,
        })
      }

      // fetch() calls
      FETCH_RE.lastIndex = 0
      while ((match = FETCH_RE.exec(line)) !== null) {
        const path = match[1]!
        // Look for method in the same or next few lines
        const context = lines.slice(i, i + 4).join(' ')
        const methodMatch = FETCH_METHOD_RE.exec(context)
        FETCH_METHOD_RE.lastIndex = 0
        const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'GET'
        calls.push({ method, path: normalizePath(path), file: filePath, line: i + 1 })
      }
    }
  }

  return calls
}

/**
 * Validate that frontend API calls match backend endpoints.
 */
export function validateContracts(
  backendFiles: Record<string, string>,
  frontendFiles: Record<string, string>,
): ContractValidationResult {
  const endpoints = extractEndpoints(backendFiles)
  const calls = extractAPICalls(frontendFiles)
  const issues: ContractIssue[] = []

  // Index endpoints by normalized path
  const endpointIndex = new Map<string, APIEndpoint[]>()
  for (const ep of endpoints) {
    const key = ep.path
    const list = endpointIndex.get(key) ?? []
    list.push(ep)
    endpointIndex.set(key, list)
  }

  const matchedEndpoints = new Set<string>()

  for (const call of calls) {
    const matchingByPath = endpointIndex.get(call.path)

    if (!matchingByPath || matchingByPath.length === 0) {
      issues.push({
        type: 'unmatched-call',
        description: `${call.method} ${call.path} has no matching backend endpoint`,
        file: call.file,
        line: call.line,
      })
      continue
    }

    const methodMatch = matchingByPath.find(ep => ep.method === call.method.toUpperCase())
    if (!methodMatch) {
      const available = matchingByPath.map(ep => ep.method).join(', ')
      issues.push({
        type: 'method-mismatch',
        description: `${call.method} ${call.path} — endpoint exists but only for ${available}`,
        file: call.file,
        line: call.line,
      })
    } else {
      matchedEndpoints.add(`${methodMatch.method}:${methodMatch.path}`)
    }
  }

  // Report unmatched endpoints as informational (not errors)
  for (const ep of endpoints) {
    const key = `${ep.method}:${ep.path}`
    if (!matchedEndpoints.has(key)) {
      issues.push({
        type: 'unmatched-endpoint',
        description: `${ep.method} ${ep.path} has no matching frontend call`,
        file: ep.file,
        line: ep.line,
      })
    }
  }

  // Only unmatched-call and method-mismatch make the result invalid
  const hasErrors = issues.some(i => i.type === 'unmatched-call' || i.type === 'method-mismatch')

  return { valid: !hasErrors, issues, endpoints, calls }
}

/** Normalize API path: strip trailing slash, collapse param segments to :param. */
function normalizePath(path: string): string {
  return path
    .replace(/\/+$/, '')   // strip trailing slash
    .replace(/\/+/g, '/')  // collapse double slashes
    .toLowerCase()
}
