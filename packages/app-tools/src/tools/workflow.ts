import type { DomainToolDefinition } from '../types.js'
import type { ExecutableDomainTool } from './shared.js'

/**
 * workflow.* — template-driven workflow invocation tools.
 *
 * A {@link WorkflowDefinition} is a lightweight template with a name,
 * description, and list of step labels. The registry is seeded via the
 * factory options; execution is delegated to an injected
 * {@link WorkflowRunner}.
 *
 * The runner contract is intentionally minimal: given a workflow name and
 * input payload, it returns a run identifier. Status is then consulted via
 * a {@link WorkflowStatusStore} which can be the same object.
 */

export type WorkflowRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  steps: string[]
}

export interface WorkflowRunRecord {
  runId: string
  workflowId: string
  status: WorkflowRunStatus
  startedAt: string
  finishedAt?: string
  error?: string
}

export interface WorkflowRunner {
  start(workflowId: string, input: Record<string, unknown>): Promise<WorkflowRunRecord>
  status(runId: string): WorkflowRunRecord | undefined
}

/**
 * Simple in-memory workflow runner that synchronously transitions each run
 * to `succeeded`. Suitable for tests and for use cases where a real workflow
 * engine isn't wired up yet.
 */
export class InMemoryWorkflowRunner implements WorkflowRunner {
  private readonly runs = new Map<string, WorkflowRunRecord>()
  private seq = 0

  constructor(
    private readonly definitions: ReadonlyMap<string, WorkflowDefinition>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(workflowId: string, _input: Record<string, unknown>): Promise<WorkflowRunRecord> {
    const def = this.definitions.get(workflowId)
    if (!def) {
      throw new Error(`workflow not found: ${workflowId}`)
    }
    this.seq += 1
    const iso = this.now().toISOString()
    const record: WorkflowRunRecord = {
      runId: `wf_run_${this.seq}`,
      workflowId,
      status: 'succeeded',
      startedAt: iso,
      finishedAt: iso,
    }
    this.runs.set(record.runId, record)
    return record
  }

  status(runId: string): WorkflowRunRecord | undefined {
    return this.runs.get(runId)
  }
}

// ---------------------------------------------------------------------------
// workflow.list
// ---------------------------------------------------------------------------

interface ListWorkflowsInput {
  namePrefix?: string
}

interface ListWorkflowsOutput {
  workflows: WorkflowDefinition[]
}

function buildWorkflowList(
  definitions: ReadonlyMap<string, WorkflowDefinition>,
): ExecutableDomainTool<ListWorkflowsInput, ListWorkflowsOutput> {
  const definition: DomainToolDefinition = {
    name: 'workflow.list',
    description: 'List registered workflow definitions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        namePrefix: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['workflows'],
      properties: {
        workflows: { type: 'array' },
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'workflow',
  }

  return {
    definition,
    async execute(input: ListWorkflowsInput): Promise<ListWorkflowsOutput> {
      const all = Array.from(definitions.values())
      const filtered =
        input.namePrefix !== undefined
          ? all.filter((w) => w.name.startsWith(input.namePrefix as string))
          : all
      return { workflows: filtered.sort((a, b) => a.name.localeCompare(b.name)) }
    },
  }
}

// ---------------------------------------------------------------------------
// workflow.run
// ---------------------------------------------------------------------------

interface RunWorkflowInput {
  workflowId: string
  input?: Record<string, unknown>
}

interface RunWorkflowOutput {
  run: WorkflowRunRecord
}

function buildWorkflowRun(
  runner: WorkflowRunner,
): ExecutableDomainTool<RunWorkflowInput, RunWorkflowOutput> {
  const definition: DomainToolDefinition = {
    name: 'workflow.run',
    description: 'Trigger a workflow run by id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', minLength: 1 },
        input: { type: 'object' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['run'],
      properties: {
        run: { type: 'object' },
      },
    },
    permissionLevel: 'write',
    sideEffects: [
      {
        type: 'creates_external_resource',
        description: 'Starts a new workflow run via the injected runner.',
      },
    ],
    namespace: 'workflow',
  }

  return {
    definition,
    async execute(input: RunWorkflowInput): Promise<RunWorkflowOutput> {
      const run = await runner.start(input.workflowId, input.input ?? {})
      return { run }
    },
  }
}

// ---------------------------------------------------------------------------
// workflow.status
// ---------------------------------------------------------------------------

interface StatusInput {
  runId: string
}

interface StatusOutput {
  run: WorkflowRunRecord | null
}

function buildWorkflowStatus(
  runner: WorkflowRunner,
): ExecutableDomainTool<StatusInput, StatusOutput> {
  const definition: DomainToolDefinition = {
    name: 'workflow.status',
    description: 'Fetch status of a workflow run by runId.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', minLength: 1 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['run'],
      properties: {
        run: {},
      },
    },
    permissionLevel: 'read',
    sideEffects: [],
    namespace: 'workflow',
  }

  return {
    definition,
    async execute(input: StatusInput): Promise<StatusOutput> {
      return { run: runner.status(input.runId) ?? null }
    },
  }
}

export function buildWorkflowTools(
  definitions: ReadonlyMap<string, WorkflowDefinition>,
  runner: WorkflowRunner,
): ExecutableDomainTool[] {
  return [
    buildWorkflowList(definitions) as unknown as ExecutableDomainTool,
    buildWorkflowRun(runner) as unknown as ExecutableDomainTool,
    buildWorkflowStatus(runner) as unknown as ExecutableDomainTool,
  ]
}
