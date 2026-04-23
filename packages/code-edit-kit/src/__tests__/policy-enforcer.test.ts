import { describe, it, expect, beforeEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { InMemoryWorkspaceFS, VirtualFS } from '@dzupagent/codegen'
import { DefaultPolicyEnforcer } from '../policy-enforcer.js'
import {
  createApplyPatchTool,
  __clearRollbackRegistry,
} from '../tools/apply-patch.tool.js'

const VALID_DIFF = [
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+line2_modified',
  ' line3',
  '',
].join('\n')

const INITIAL_FILE = ['line1', 'line2', 'line3', ''].join('\n')

function makeWorkspace(
  seed: Record<string, string> = {},
): InMemoryWorkspaceFS {
  const vfs = new VirtualFS()
  for (const [path, content] of Object.entries(seed)) {
    vfs.write(path, content)
  }
  return new InMemoryWorkspaceFS(vfs)
}

beforeEach(() => {
  __clearRollbackRegistry()
})

describe('DefaultPolicyEnforcer — read-only tier', () => {
  it('denies any write call outright', async () => {
    const enforcer = new DefaultPolicyEnforcer([], 'read-only')
    const res = await enforcer.enforce({
      diff: VALID_DIFF,
      filesModified: ['src/index.ts'],
      linesAdded: 1,
      linesRemoved: 1,
    })
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('read-only sandbox')
  })

  it('blocks apply_patch via the tool wiring and surfaces the reason', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const enforcer = new DefaultPolicyEnforcer([], 'read-only')
    const tool = createApplyPatchTool(ws, { policyEnforcer: enforcer })

    const result = await tool.invoke({ diff: VALID_DIFF })
    expect(result).toContain('denied by policy')
    expect(result).toContain('read-only sandbox')

    // File is untouched.
    expect(await ws.read('src/index.ts')).toBe(INITIAL_FILE)
  })
})

describe('DefaultPolicyEnforcer — workspace-write tier', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'policy-enforcer-'))
  })

  it('rejects absolute paths outside the workspace root', async () => {
    const enforcer = new DefaultPolicyEnforcer([], 'workspace-write', tmp)
    const outside = '/etc/passwd'
    const res = await enforcer.enforce({
      diff: VALID_DIFF,
      filesModified: [outside],
    })
    expect(res.valid).toBe(false)
    expect(res.reason).toContain('outside workspace')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('allows absolute paths inside the workspace root', async () => {
    const enforcer = new DefaultPolicyEnforcer([], 'workspace-write', tmp)
    const inside = resolve(tmp, 'src/a.ts')
    const res = await enforcer.enforce({
      diff: VALID_DIFF,
      filesModified: [inside],
    })
    expect(res.valid).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('allows relative paths (treated as workspace-relative)', async () => {
    const enforcer = new DefaultPolicyEnforcer([], 'workspace-write', tmp)
    const res = await enforcer.enforce({
      diff: VALID_DIFF,
      filesModified: ['src/a.ts'],
    })
    expect(res.valid).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects when workspaceRoot is missing', async () => {
    // Intentionally omit workspaceRoot to exercise the guard.
    const enforcer = new DefaultPolicyEnforcer([], 'workspace-write')
    const res = await enforcer.enforce({
      diff: VALID_DIFF,
      filesModified: ['/tmp/a.ts'],
    })
    expect(res.valid).toBe(false)
    expect(res.reason).toContain('workspaceRoot')
  })
})

describe('DefaultPolicyEnforcer — full-access tier', () => {
  it('is a no-op gate and allows any write', async () => {
    const enforcer = new DefaultPolicyEnforcer([], 'full-access')
    const res = await enforcer.enforce({
      diff: VALID_DIFF,
      filesModified: ['/anywhere/at/all.ts', 'rel/path.ts'],
    })
    expect(res.valid).toBe(true)
  })

  it('still applies patches normally when wired into apply_patch', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const enforcer = new DefaultPolicyEnforcer([], 'full-access')
    const tool = createApplyPatchTool(ws, { policyEnforcer: enforcer })

    const result = await tool.invoke({ diff: VALID_DIFF })
    expect(result).toContain('Patch applied to 1 file')

    const after = await ws.read('src/index.ts')
    expect(after).toContain('line2_modified')
  })
})

describe('DefaultPolicyEnforcer — hooks pass-through', () => {
  it('exposes registered hooks via the `hooks` readonly field', () => {
    const hook = {
      name: 'x',
      trigger: 'always' as const,
      failureAction: 'warn' as const,
      run: () => ({ valid: true }),
    }
    const enforcer = new DefaultPolicyEnforcer([hook], 'full-access')
    expect(enforcer.hooks).toHaveLength(1)
    expect(enforcer.hooks[0]!.name).toBe('x')
    expect(enforcer.tier).toBe('full-access')
  })
})
