# 05 — Agent Layer Enhancements

> **Gaps addressed**: G-11 (workflow engine), G-12 (parallel orchestration), G-19 (sub-agent ReAct), G-26 (agents-as-tools), G-27 (stuck detection)

---

## 1. General-Purpose Workflow Engine (G-11)

### Problem
`GenPipelineBuilder` is codegen-specific. There's no way to compose arbitrary multi-step workflows with branching, parallelism, or suspend/resume — a feature that Mastra, Gnana, and LangGraph natively support.

### Solution: Workflow Builder in `@dzipagent/agent`

```typescript
// agent/src/workflow/workflow-builder.ts
export interface WorkflowStep<TInput = unknown, TOutput = unknown> {
  id: string;
  description?: string;
  inputSchema?: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>;
}

export class WorkflowBuilder<TState extends Record<string, unknown>> {
  private steps: WorkflowNode[] = [];

  /** Add a sequential step */
  then<T extends WorkflowStep>(step: T): WorkflowBuilder<TState> {
    this.steps.push({ type: 'step', step });
    return this;
  }

  /** Run multiple steps in parallel, merge results */
  parallel(steps: WorkflowStep[], mergeStrategy?: MergeStrategy): WorkflowBuilder<TState> {
    this.steps.push({ type: 'parallel', steps, mergeStrategy: mergeStrategy ?? 'merge-objects' });
    return this;
  }

  /** Conditional branching */
  branch(
    condition: (state: TState) => string,
    branches: Record<string, WorkflowStep | WorkflowStep[]>
  ): WorkflowBuilder<TState> {
    this.steps.push({ type: 'branch', condition, branches });
    return this;
  }

  /** Fan-out to N workers, aggregate results */
  mapReduce<TItem, TResult>(
    splitter: (state: TState) => TItem[],
    worker: WorkflowStep<TItem, TResult>,
    reducer: (results: TResult[]) => unknown,
    options?: { maxConcurrency?: number }
  ): WorkflowBuilder<TState> {
    this.steps.push({ type: 'map-reduce', splitter, worker, reducer, options });
    return this;
  }

  /** Suspend execution until external resume (HITL) */
  suspend(
    reason: string,
    resumeSchema?: z.ZodType
  ): WorkflowBuilder<TState> {
    this.steps.push({ type: 'suspend', reason, resumeSchema });
    return this;
  }

  /** Compile to executable workflow */
  build(): CompiledWorkflow<TState> {
    return new CompiledWorkflow(this.steps);
  }
}

// Factory function
export function createWorkflow<T extends Record<string, unknown>>(config: {
  id: string;
  inputSchema?: z.ZodType<T>;
  description?: string;
}): WorkflowBuilder<T> {
  return new WorkflowBuilder<T>(config);
}
```

### Usage Examples

```typescript
// Code generation workflow
const codegenWorkflow = createWorkflow({
  id: 'feature-pipeline',
  inputSchema: z.object({ spec: z.string(), techStack: z.string() }),
})
  .then(planStep)                           // Generate plan
  .suspend('plan_review')                   // Wait for human review
  .parallel([genBackendStep, genFrontendStep, genTestsStep])  // Generate in parallel
  .then(validateStep)                        // TypeCheck + lint
  .branch(
    (state) => state.validationPassed ? 'publish' : 'fix',
    {
      publish: publishStep,
      fix: [fixStep, validateStep],          // Fix then re-validate
    }
  )
  .build();

// DevOps workflow
const incidentWorkflow = createWorkflow({
  id: 'incident-response',
  inputSchema: z.object({ alert: z.string() }),
})
  .then(detectStep)
  .then(diagnoseStep)
  .then(planRemediationStep)
  .suspend('remediation_approval')
  .then(executeRemediationStep)
  .then(verifyStep)
  .build();

// Data analysis workflow
const analysisWorkflow = createWorkflow({
  id: 'data-analysis',
  inputSchema: z.object({ dataset: z.string(), question: z.string() }),
})
  .then(ingestStep)
  .parallel([exploreStep, profileStep])
  .then(analyzeStep)
  .then(visualizeStep)
  .then(reportStep)
  .build();
```

### Workflow Runner (LangGraph Compilation)

```typescript
// agent/src/workflow/workflow-runner.ts
export class CompiledWorkflow<TState> {
  constructor(private nodes: WorkflowNode[]) {}

  /** Compile to LangGraph StateGraph for execution */
  toStateGraph(): StateGraph {
    const graph = new StateGraph({ channels: { ... } });

    for (const node of this.nodes) {
      switch (node.type) {
        case 'step':
          graph.addNode(node.step.id, async (state) => {
            return node.step.execute(state, context);
          });
          break;
        case 'parallel':
          // Add a fan-out node that runs steps concurrently
          graph.addNode(`parallel_${id}`, async (state) => {
            const results = await Promise.all(
              node.steps.map(s => s.execute(state, context))
            );
            return mergeResults(results, node.mergeStrategy);
          });
          break;
        case 'suspend':
          // Add an interrupt node that pauses execution
          graph.addNode(`suspend_${id}`, async (state) => {
            return { __interrupt: { reason: node.reason } };
          });
          break;
        // ... branch, map-reduce
      }
    }

    return graph;
  }

  /** Execute the workflow */
  async run(input: TState, config?: { checkpointer?: BaseCheckpointSaver }): Promise<TState> {
    const graph = this.toStateGraph().compile({ checkpointer: config?.checkpointer });
    const result = await graph.invoke(input);
    return result;
  }

  /** Stream workflow execution events */
  async *stream(input: TState): AsyncIterable<WorkflowEvent> {
    const graph = this.toStateGraph().compile();
    for await (const event of graph.streamEvents(input)) {
      yield this.transformEvent(event);
    }
  }
}
```

---

## 2. Multi-Agent Orchestration Patterns (G-12)

### Problem
Sub-agents are isolated workers. No coordination protocol for complex multi-agent scenarios.

### Solution: Orchestrator Patterns

```typescript
// agent/src/orchestration/orchestrator.ts
export class AgentOrchestrator {
  /** Run agents sequentially, each receives previous output */
  static sequential(agents: DzipAgent[]): DzipAgent {
    return new DzipAgent({
      id: `seq_${agents.map(a => a.id).join('_')}`,
      instructions: 'Orchestrate sequential agent pipeline',
      tools: [],
      execute: async (input) => {
        let state = input;
        for (const agent of agents) {
          state = await agent.generate([{ role: 'user', content: JSON.stringify(state) }]);
        }
        return state;
      },
    });
  }

  /** Run agents in parallel, merge results */
  static parallel(
    agents: DzipAgent[],
    merger?: (results: string[]) => string | Promise<string>
  ): DzipAgent {
    return new DzipAgent({
      id: `par_${agents.map(a => a.id).join('_')}`,
      instructions: 'Orchestrate parallel agents',
      execute: async (input) => {
        const results = await Promise.all(
          agents.map(a => a.generate([{ role: 'user', content: JSON.stringify(input) }]))
        );
        return merger ? await merger(results) : results.join('\n---\n');
      },
    });
  }

  /** Supervisor pattern: manager delegates to specialists */
  static supervisor(
    manager: DzipAgent,
    specialists: DzipAgent[]
  ): DzipAgent {
    // Wrap each specialist as a tool for the manager
    const specialistTools = specialists.map(s => s.asTool());
    return new DzipAgent({
      ...manager.config,
      tools: [...(manager.config.tools ?? []), ...specialistTools],
    });
  }

  /** Debate: multiple agents propose, best solution selected */
  static debate(
    proposers: DzipAgent[],
    judge: DzipAgent,
    rounds?: number
  ): DzipAgent {
    return new DzipAgent({
      id: 'debate',
      execute: async (input) => {
        const proposals = await Promise.all(
          proposers.map(a => a.generate([{ role: 'user', content: JSON.stringify(input) }]))
        );
        const judgeInput = proposals.map((p, i) => `Proposal ${i + 1}:\n${p}`).join('\n\n');
        return judge.generate([{
          role: 'user',
          content: `Evaluate these proposals and select the best one:\n\n${judgeInput}`,
        }]);
      },
    });
  }
}
```

### Fluent API

```typescript
// Usage
const pipeline = AgentOrchestrator.supervisor(
  architectAgent,
  [dbAgent, apiAgent, frontendAgent]
);

const reviewPipeline = AgentOrchestrator.sequential([
  codeGenAgent,
  AgentOrchestrator.parallel([securityReviewAgent, performanceReviewAgent]),
  finalReviewAgent,
]);
```

---

## 3. Full ReAct Loop for Sub-Agents (G-19)

### Problem
`SubAgentSpawner` does single-turn invocation. Sub-agents can't use tools iteratively.

### Solution: Reuse `runToolLoop()` from agent package

```typescript
// agent/src/agent/tool-loop.ts — ENHANCED

export async function runToolLoop(
  model: BaseChatModel,
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
  config: {
    maxIterations: number;
    budget: IterationBudget;
    eventBus?: DzipEventBus;
    isSubAgent?: boolean;  // NEW: flag for sub-agent mode
  }
): Promise<ToolLoopResult> {
  // Existing implementation, now also used by SubAgentSpawner
  // Budget is forked from parent (not shared) to prevent sub-agent from
  // exhausting parent's budget
}
```

```typescript
// core/src/subagent/subagent-spawner.ts — ENHANCED

export class SubAgentSpawner {
  async spawn(config: SubAgentConfig): Promise<SubAgentResult> {
    // ... existing context filtering ...

    // NEW: Full ReAct loop instead of single-turn
    const result = await runToolLoop(
      model,
      messages,
      config.tools ?? [],
      {
        maxIterations: config.maxIterations ?? 5,
        budget: parentBudget.fork(),  // Forked budget
        eventBus: this.eventBus,
        isSubAgent: true,
      }
    );

    // Merge file changes back to parent VFS
    if (config.vfs) {
      mergeFileChanges(config.vfs, result.files);
    }

    return result;
  }
}
```

---

## 4. Agents-as-Tools Pattern (G-26)

### Problem
Sub-agents are spawned procedurally. The parent agent can't invoke them via LLM function calling.

### Solution: `DzipAgent.asTool()`

```typescript
// agent/src/agent/dzip-agent.ts — ENHANCED

export class DzipAgent {
  /** Expose this agent as a LangChain tool for use by other agents */
  asTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: `agent_${this.id}`,
      description: this.config.description ?? `Invoke the ${this.config.name ?? this.id} agent`,
      schema: z.object({
        task: z.string().describe('The task to delegate to this agent'),
        context: z.string().optional().describe('Additional context'),
      }),
      func: async ({ task, context }) => {
        const messages: BaseMessage[] = [
          new HumanMessage(context ? `${task}\n\nContext: ${context}` : task),
        ];
        return this.generate(messages);
      },
    });
  }

  /** Stream results back to parent as they become available */
  async *asStreamingTool(task: string): AsyncIterable<string> {
    for await (const event of this.stream([new HumanMessage(task)])) {
      if (event.type === 'text') yield event.data;
    }
  }
}
```

---

## 5. Stuck Detection (G-27)

### Problem
No detection of repeated failures, circular tool calls, or no-progress loops.

### Solution

```typescript
// agent/src/guardrails/stuck-detector.ts
export class StuckDetector {
  private recentToolCalls: Array<{ name: string; inputHash: string; timestamp: number }> = [];
  private recentErrors: Array<{ message: string; timestamp: number }> = [];

  constructor(private config: {
    /** Max identical sequential tool calls before flagging */
    maxRepeatCalls: number;       // default: 3
    /** Max errors in a window before flagging */
    maxErrorsInWindow: number;    // default: 5
    errorWindowMs: number;        // default: 60_000
    /** Max iterations without progress (new files, edits, or tests passing) */
    maxNoProgressIterations: number; // default: 5
  }) {}

  recordToolCall(name: string, input: unknown): StuckStatus {
    const inputHash = hashInput(input);
    this.recentToolCalls.push({ name, inputHash, timestamp: Date.now() });

    // Check for repeated identical calls
    const recent = this.recentToolCalls.slice(-this.config.maxRepeatCalls);
    if (recent.length >= this.config.maxRepeatCalls &&
        recent.every(c => c.name === name && c.inputHash === inputHash)) {
      return { stuck: true, reason: `Repeated ${name} call ${this.config.maxRepeatCalls}x with same input` };
    }

    return { stuck: false };
  }

  recordError(error: Error): StuckStatus {
    this.recentErrors.push({ message: error.message, timestamp: Date.now() });

    // Check error rate in window
    const windowStart = Date.now() - this.config.errorWindowMs;
    const recentErrors = this.recentErrors.filter(e => e.timestamp >= windowStart);
    if (recentErrors.length >= this.config.maxErrorsInWindow) {
      return { stuck: true, reason: `${recentErrors.length} errors in ${this.config.errorWindowMs / 1000}s` };
    }

    return { stuck: false };
  }
}

type StuckStatus = { stuck: false } | { stuck: true; reason: string };
```

---

## 6. Implementation Estimates

| Component | Files | ~LOC | Priority |
|-----------|-------|------|----------|
| Workflow builder | 1 | 200 | P1 |
| Workflow runner (LangGraph compiler) | 1 | 250 | P1 |
| Workflow types | 1 | 60 | P1 |
| Suspend/resume | 1 | 100 | P1 |
| Orchestrator patterns | 1 | 150 | P1 |
| Merge strategies | 1 | 60 | P1 |
| Agents-as-tools (`asTool()`) | existing file | 40 | P0 |
| Sub-agent full ReAct | existing file | 60 | P1 |
| Stuck detector | 1 | 80 | P1 |
| **Total** | **~8 files** | **~1,000 LOC** | |
