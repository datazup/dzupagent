/**
 * Machine-readable statement of workflow ownership. This keeps the boundary
 * testable without adding a runtime package edge to `@dzupagent/flow-compiler`.
 */
export const ADAPTER_WORKFLOW_OWNERSHIP = {
  owner: 'agent-adapters',
  canonicalContract: '@dzupagent/core:PipelineDefinition',
  runtime: '@dzupagent/agent:PipelineRuntime',
  flowCompilerDependency: 'none',
  equivalentConstructs: [
    'sequential-step-order',
    'conditional-branch-targets',
  ],
  adapterOwnedConstructs: [
    'provider-routing',
    'prompt-templating',
    'parallel-merge-strategy',
    'loop-iteration-policy',
    'adapter-workflow-events',
    'retry-and-timeout-policy',
  ],
} as const
