import type { AgentTask } from "../fleet/index.js";
import type { ImplementationRepoRef, ImplementationTask } from "./types.js";

export interface MapImplementationTaskToAgentTaskInput {
  task: ImplementationTask;
  repo: ImplementationRepoRef;
}

export function mapImplementationTaskToAgentTask({
  task,
  repo,
}: MapImplementationTaskToAgentTaskInput): AgentTask {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    workingDirectory: repo.path,
    targetRepo: repo.id,
    scopeFiles: task.scopeFiles,
    acceptanceCriteria: task.acceptanceCriteria,
    validationCommands: task.validationCommands,
    dependsOn: task.dependsOn,
    maxAttempts: task.maxAttempts,
    risk: task.risk,
    tags: task.tags,
    provider: task.provider,
    runtimePolicy: task.runtimePolicy,
    payload: {
      implementation: {
        repoId: task.repoId,
        repoPath: repo.path,
        instructions: repo.instructions ?? [],
      },
    },
  };
}
