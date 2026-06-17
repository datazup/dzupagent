import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { flowApprovals } from "./drizzle-schema.js";

export type FlowApprovalStatus = "pending" | "approved" | "rejected";

export interface FlowApproval {
  tenantId?: string | null;
  runId: string;
  approvalId: string;
  status: FlowApprovalStatus;
  requestPayload: Record<string, unknown>;
  responsePayload?: Record<string, unknown> | null;
  resolvedAt?: Date | null;
}

export interface FlowApprovalStore {
  create(
    approval: Pick<
      FlowApproval,
      "tenantId" | "runId" | "approvalId" | "requestPayload"
    >,
  ): Promise<FlowApproval>;
  resolve(
    runId: string,
    approvalId: string,
    status: Exclude<FlowApprovalStatus, "pending">,
    responsePayload: Record<string, unknown>,
  ): Promise<FlowApproval>;
  get(runId: string, approvalId: string): Promise<FlowApproval | undefined>;
  listByRun(runId: string): Promise<FlowApproval[]>;
}

export class InMemoryFlowApprovalStore implements FlowApprovalStore {
  private readonly store = new Map<string, FlowApproval>();

  async create(
    input: Pick<
      FlowApproval,
      "tenantId" | "runId" | "approvalId" | "requestPayload"
    >,
  ): Promise<FlowApproval> {
    const key = approvalKey(input.runId, input.approvalId);
    const existing = this.store.get(key);
    if (existing) return existing;

    const record: FlowApproval = {
      ...input,
      tenantId: input.tenantId ?? "default",
      status: "pending",
      responsePayload: null,
      resolvedAt: null,
    };
    this.store.set(key, record);
    return record;
  }

  async resolve(
    runId: string,
    approvalId: string,
    status: Exclude<FlowApprovalStatus, "pending">,
    responsePayload: Record<string, unknown>,
  ): Promise<FlowApproval> {
    const key = approvalKey(runId, approvalId);
    const existing = this.store.get(key);
    if (!existing) {
      throw new Error(`FlowApproval not found: ${runId}/${approvalId}`);
    }
    if (existing.status !== "pending") {
      if (existing.status === status) return existing;
      throw new Error(`FlowApproval already resolved: ${runId}/${approvalId}`);
    }
    const updated: FlowApproval = {
      ...existing,
      status,
      responsePayload,
      resolvedAt: new Date(),
    };
    this.store.set(key, updated);
    return updated;
  }

  async get(
    runId: string,
    approvalId: string,
  ): Promise<FlowApproval | undefined> {
    return this.store.get(approvalKey(runId, approvalId));
  }

  async listByRun(runId: string): Promise<FlowApproval[]> {
    return [...this.store.values()].filter((a) => a.runId === runId);
  }
}

function approvalKey(runId: string, approvalId: string): string {
  return `${runId}\0${approvalId}`;
}

type DB = PostgresJsDatabase<Record<string, never>>;

interface FlowApprovalRow {
  tenantId: string;
  runId: string;
  approvalId: string;
  status: FlowApprovalStatus;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  resolvedAt: Date | null;
}

function rowToApproval(row: FlowApprovalRow): FlowApproval {
  return {
    tenantId: row.tenantId,
    runId: row.runId,
    approvalId: row.approvalId,
    status: row.status,
    requestPayload: row.requestPayload,
    responsePayload: row.responsePayload,
    resolvedAt: row.resolvedAt,
  };
}

export class PostgresFlowApprovalStore implements FlowApprovalStore {
  constructor(private readonly db: DB) {}

  async create(
    input: Pick<
      FlowApproval,
      "tenantId" | "runId" | "approvalId" | "requestPayload"
    >,
  ): Promise<FlowApproval> {
    const rows = (await this.db
      .insert(flowApprovals)
      .values({
        tenantId: input.tenantId ?? "default",
        runId: input.runId,
        approvalId: input.approvalId,
        status: "pending",
        requestPayload: input.requestPayload,
        responsePayload: null,
        resolvedAt: null,
      })
      .onConflictDoUpdate({
        target: [flowApprovals.runId, flowApprovals.approvalId],
        // No-op update: duplicate create returns the original pending/resolved row.
        set: { approvalId: input.approvalId },
      })
      .returning()) as FlowApprovalRow[];
    const row = rows[0];
    if (!row) throw new Error(`FlowApproval insert failed: ${input.approvalId}`);
    return rowToApproval(row);
  }

  async resolve(
    runId: string,
    approvalId: string,
    status: Exclude<FlowApprovalStatus, "pending">,
    responsePayload: Record<string, unknown>,
  ): Promise<FlowApproval> {
    const existing = await this.get(runId, approvalId);
    if (!existing) {
      throw new Error(`FlowApproval not found: ${runId}/${approvalId}`);
    }
    if (existing.status !== "pending") {
      if (existing.status === status) return existing;
      throw new Error(`FlowApproval already resolved: ${runId}/${approvalId}`);
    }
    const rows = (await this.db
      .update(flowApprovals)
      .set({
        status,
        responsePayload,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(flowApprovals.runId, runId),
          eq(flowApprovals.approvalId, approvalId),
        ),
      )
      .returning()) as FlowApprovalRow[];
    const row = rows[0];
    if (!row) throw new Error(`FlowApproval not found: ${runId}/${approvalId}`);
    return rowToApproval(row);
  }

  async get(
    runId: string,
    approvalId: string,
  ): Promise<FlowApproval | undefined> {
    const rows = (await this.db
      .select()
      .from(flowApprovals)
      .where(
        and(
          eq(flowApprovals.runId, runId),
          eq(flowApprovals.approvalId, approvalId),
        ),
      )
      .limit(1)) as FlowApprovalRow[];
    const row = rows[0];
    return row ? rowToApproval(row) : undefined;
  }

  async listByRun(runId: string): Promise<FlowApproval[]> {
    const rows = (await this.db
      .select()
      .from(flowApprovals)
      .where(eq(flowApprovals.runId, runId))) as FlowApprovalRow[];
    return rows.map(rowToApproval);
  }
}
