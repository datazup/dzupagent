import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function readArchitectureDoc(): string {
  return readFileSync(new URL('../../ARCHITECTURE.md', import.meta.url), 'utf-8')
}

function readPackageArchitectureDoc(): string {
  return readFileSync(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf-8')
}

function readAuthoringSurfaceMatrix(): string {
  return readFileSync(
    new URL('../../../../docs/flow-orchestration-authoring-surfaces.md', import.meta.url),
    'utf-8',
  )
}

function readPackageExports(): string[] {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
  const packageJson = JSON.parse(raw) as { exports?: Record<string, unknown> }
  return Object.keys(packageJson.exports ?? {})
}

describe('architecture docs', () => {
  it('root ARCHITECTURE.md exists and includes core architecture sections', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('# @dzupagent/agent-adapters Architecture')
    expect(content).toContain('## Responsibilities')
    expect(content).toContain('## Structure')
    expect(content).toContain('## Runtime and Control Flow')
  })

  it('root ARCHITECTURE.md documents critical runtime components and routing', () => {
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

  it('root ARCHITECTURE.md includes testing and observability coverage information', () => {
    const content = readArchitectureDoc()

    expect(content).toContain('## Testing and Observability')
    expect(content).toContain('Vitest')
    expect(content).toContain('src/**/*.test.ts')
  })

  it('root and package architecture docs list every package export subpath', () => {
    const rootContent = readArchitectureDoc()
    const packageContent = readPackageArchitectureDoc()

    for (const exportPath of readPackageExports()) {
      expect(rootContent).toContain(`\`${exportPath}\``)
      expect(packageContent).toContain(`\`${exportPath}\``)
    }
  })

  it('does not preserve the stale root-only export claim', () => {
    const docs = [readArchitectureDoc(), readPackageArchitectureDoc()]

    for (const content of docs) {
      expect(content).not.toContain('exports currently exposes only `"."`')
      expect(content).not.toContain('currently exports only the root entrypoint')
      expect(content).not.toContain('not currently declared package subpath exports')
    }
  })

  it('authoring surface matrix names the public flow and orchestration owners', () => {
    const content = readAuthoringSurfaceMatrix()

    for (const expected of [
      '@dzupagent/flow-ast',
      '@dzupagent/flow-dsl',
      '@dzupagent/flow-compiler',
      '@dzupagent/agent',
      '@dzupagent/agent-adapters',
      'FlowDocumentV1',
      'dzupflow/v1',
      'AdapterWorkflowBuilder',
      'PlanningAgent.ExecutionPlan',
      'TeamDefinition',
    ]) {
      expect(content).toContain(expected)
    }
  })
})
