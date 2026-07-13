/**
 * DZUPAGENT-ERR-H-09 — git tools error containment.
 *
 * Proves that raw execFile stderr — pre-commit hook output, credentialed remote
 * URLs, and absolute internal filesystem paths — never reaches the tool output
 * returned to the LLM, and that the sanitized failure is logged admin-side with
 * full detail via structured stderr.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createGitTools } from '../git-tools.js'
import type { GitExecutor } from '../git-executor.js'
import { handleGitToolError } from '../git-errors.js'

// Representative raw git failure: hook output + credentialed remote + internal path.
const RAW_HOOK =
  'husky > pre-commit hook failed (exit 1)\n' +
  'ESLint error at /home/ci/secret-workspace/apps/internal/src/keys.ts\n' +
  'remote: https://x-access-token:ghp_ABCDEFteststoken1234567890abcdef@github.com/acme/private.git'

const LEAK_FRAGMENTS = [
  'husky',
  'pre-commit',
  '/home/ci/secret-workspace',
  'ghp_ABCDEFteststoken1234567890abcdef',
  'x-access-token',
  'github.com/acme/private.git',
]

function leakyExecutor(): GitExecutor {
  const boom = async () => {
    throw new Error(RAW_HOOK)
  }
  return {
    status: boom,
    diff: boom,
    log: boom,
    listBranches: boom,
    addAll: boom,
    add: boom,
    commit: boom,
    createBranch: boom,
    switchBranch: boom,
  } as unknown as GitExecutor
}

function toolByName(name: string) {
  // allowMutatingTools so git_commit / git_branch reach the executor (and thus
  // the catch path) instead of returning the policy-denied stub.
  const tools = createGitTools(leakyExecutor(), { allowMutatingTools: true })
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DZUPAGENT-ERR-H-09 — git tools never leak hook output / paths / remote URLs', () => {
  const cases: Array<{ tool: string; input: unknown }> = [
    { tool: 'git_status', input: {} },
    { tool: 'git_diff', input: {} },
    { tool: 'git_log', input: {} },
    { tool: 'git_commit', input: { message: 'wip', addAll: true } },
    { tool: 'git_branch', input: { action: 'list' } },
  ]

  for (const { tool, input } of cases) {
    it(`${tool} output contains no hook output, internal path, or credentialed URL`, async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await (toolByName(tool) as any).invoke(input)
      for (const frag of LEAK_FRAGMENTS) {
        expect(out).not.toContain(frag)
      }
      const parsed = JSON.parse(out)
      expect(typeof parsed.error).toBe('string')
      errSpy.mockRestore()
    })
  }

  it('git_commit hook failure maps to the hook_failed category summary', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (toolByName('git_commit') as any).invoke({ message: 'x', addAll: true })
    const parsed = JSON.parse(out)
    expect(parsed.error).toMatch(/git hook rejected/i)
    expect(parsed.success).toBe(false)
    errSpy.mockRestore()
  })

  it('logs full raw detail admin-side with secrets redacted in the log too', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const summary = handleGitToolError('git_commit', new Error(RAW_HOOK))

    // LLM-safe summary carries no raw text.
    for (const frag of LEAK_FRAGMENTS) {
      expect(summary).not.toContain(frag)
    }

    expect(errSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(errSpy.mock.calls[0]![0] as string)
    expect(logged.component).toBe('git-tools')
    expect(logged.operation).toBe('git_commit')
    expect(logged.category).toBe('hook_failed')
    // Admin log keeps hook output/paths for debugging, but the credentialed
    // remote token is redacted even server-side.
    expect(logged.error.message).toContain('pre-commit')
    expect(logged.error.message).not.toContain('ghp_ABCDEFteststoken1234567890abcdef')
    errSpy.mockRestore()
  })
})
