import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function readArchitectureDoc(): string {
  return readFileSync(new URL('../../ARCHITECTURE.md', import.meta.url), 'utf-8')
}

describe('ARCHITECTURE.md', () => {
  it('exists and includes core architecture sections', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('# @dzupagent/agent-adapters Architecture')
    expect(content).toContain('## 2. High-Level Architecture')
    expect(content).toContain('## 6. Feature Inventory by Subsystem')
    expect(content).toContain('## 8. How To Use')
  })

  it('documents critical runtime components and routing', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('AdapterRegistry')
    expect(content).toContain('OrchestratorFacade')
    expect(content).toContain('ParallelExecutor')
    expect(content).toContain('SupervisorOrchestrator')
    expect(content).toContain('MapReduceOrchestrator')
    expect(content).toContain('ContractNetOrchestrator')
    expect(content).toContain('TagBasedRouter')
    expect(content).toContain('CapabilityRouter')
    expect(content).toContain('ContextAwareRouter')
  })

  it('includes a related tests map for feature coverage', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('## 13. Test Coverage Map')
    expect(content).toContain('adapter-registry.test.ts')
    expect(content).toContain('parallel-executor.test.ts')
    expect(content).toContain('adapter-http-handler.test.ts')
    expect(content).toContain('adapter-recovery.test.ts')
    expect(content).toContain('architecture-doc.test.ts')
  })
})
