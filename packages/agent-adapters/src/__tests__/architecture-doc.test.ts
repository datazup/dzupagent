import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function readArchitectureDoc(): string {
  return readFileSync(new URL('../../ARCHITECTURE.md', import.meta.url), 'utf-8')
}

describe('ARCHITECTURE.md', () => {
  it('exists and includes core architecture sections', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('# @dzupagent/agent-adapters Architecture')
    expect(content).toContain('## Responsibilities')
    expect(content).toContain('## Structure')
    expect(content).toContain('## Runtime and Control Flow')
  })

  it('documents critical runtime components and routing', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('ProviderAdapterRegistry')
    expect(content).toContain('OrchestratorFacade')
    expect(content).toContain('ParallelExecutor')
    expect(content).toContain('SupervisorOrchestrator')
    expect(content).toContain('MapReduceOrchestrator')
    expect(content).toContain('ContractNetOrchestrator')
    expect(content).toContain('TagBasedRouter')
    expect(content).toContain('CapabilityRouter')
    expect(content).toContain('ContextAwareRouter')
  })

  it('includes testing and observability coverage information', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('## Testing and Observability')
    expect(content).toContain('Vitest')
    expect(content).toContain('src/**/*.test.ts')
  })
})
