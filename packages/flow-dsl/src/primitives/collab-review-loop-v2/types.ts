export class CollabReviewLoopV2Error extends Error {
  constructor(message: string) {
    super(`collab.review_loop@2: ${message}`);
    this.name = "CollabReviewLoopV2Error";
  }
}

export interface ImmutableIdentity {
  runId: string;
  planId: string;
  planHash: string;
  taskId: string;
  taskDefinitionHash: string;
  repoId: string;
  baseline: {
    commit: string;
    tree: string;
  };
}

export interface ReviewLoopActor {
  provider: string;
  model?: string;
  persona: string;
  instructions: string;
  capabilities: string[];
  output: string;
}

export interface ReviewLoopSchemas {
  implementer: string | Record<string, unknown>;
  reviewer: string;
}

export interface EvidenceSources {
  diff: string;
  validation: string;
}

export interface TerminalMapping {
  accepted: string;
  blockedExternal: string;
  rejectedScope: string;
  rejectedCorrectness: string;
  invalidReviewerVerdict: string;
}

export interface ReviewLoopV2Input {
  id: string;
  identity: ImmutableIdentity;
  implementer: ReviewLoopActor;
  reviewer: ReviewLoopActor;
  schemas: ReviewLoopSchemas;
  evidence: EvidenceSources;
  validationRef: string;
  reconcile: { maxRevise: number };
  terminals: TerminalMapping;
}
