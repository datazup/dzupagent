import { describe, expect, it } from 'vitest'
import type { AgentInput } from '../index.js'

describe('AgentInput execution policy context', () => {
  it('carries a neutral signed policy without adding product identity', () => {
    const executionPolicy = {
      policy: { version: 'v1', policyId: 'execution-1', wallTimeSec: 60, egressGrants: [] },
      catalog: { version: 'v1', digest: 'a'.repeat(64), entries: [] },
      signature: 'b'.repeat(64),
    }
    const input: AgentInput = { prompt: 'run', policyContext: { executionPolicy } }

    expect(input.policyContext?.executionPolicy?.signature).toHaveLength(64)
    expect(JSON.stringify(input.policyContext)).not.toMatch(/tenantId|workspaceId|userId/)
  })
})
