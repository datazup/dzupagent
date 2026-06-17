export type FlowApprovalStatus = "pending" | "approved" | "rejected";

export interface FlowApproval {
  runId: string;
  approvalId: string;
  status: FlowApprovalStatus;
  requestPayload: Record<string, unknown>;
  responsePayload?: Record<string, unknown> | null;
  resolvedAt?: Date | null;
}

export interface FlowApprovalStore {
  create(
    approval: Pick<FlowApproval, "runId" | "approvalId" | "requestPayload">,
  ): Promise<FlowApproval>;
  resolve(
    approvalId: string,
    status: Exclude<FlowApprovalStatus, "pending">,
    responsePayload: Record<string, unknown>,
  ): Promise<FlowApproval>;
  get(approvalId: string): Promise<FlowApproval | undefined>;
  listByRun(runId: string): Promise<FlowApproval[]>;
}

export class InMemoryFlowApprovalStore implements FlowApprovalStore {
  private readonly store = new Map<string, FlowApproval>();

  async create(
    input: Pick<FlowApproval, "runId" | "approvalId" | "requestPayload">,
  ): Promise<FlowApproval> {
    const record: FlowApproval = {
      ...input,
      status: "pending",
      responsePayload: null,
      resolvedAt: null,
    };
    this.store.set(input.approvalId, record);
    return record;
  }

  async resolve(
    approvalId: string,
    status: Exclude<FlowApprovalStatus, "pending">,
    responsePayload: Record<string, unknown>,
  ): Promise<FlowApproval> {
    const existing = this.store.get(approvalId);
    if (!existing) throw new Error(`FlowApproval not found: ${approvalId}`);
    const updated: FlowApproval = {
      ...existing,
      status,
      responsePayload,
      resolvedAt: new Date(),
    };
    this.store.set(approvalId, updated);
    return updated;
  }

  async get(approvalId: string): Promise<FlowApproval | undefined> {
    return this.store.get(approvalId);
  }

  async listByRun(runId: string): Promise<FlowApproval[]> {
    return [...this.store.values()].filter((a) => a.runId === runId);
  }
}
