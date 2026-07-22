import type {
  MemoryRecord,
  MemoryScope,
  MemoryQuery,
} from "@dzupagent/agent-types";

export const DEFAULT_TIMEOUT_MS = 10_000;

const SCOPE_FIELDS: Array<keyof MemoryScope> = [
  "tenantId",
  "workspaceId",
  "projectId",
  "taskId",
];

export function validateScope(scope: MemoryScope): void {
  if (!scope || typeof scope !== "object") {
    throw new Error("Memory scope must be an object");
  }

  for (const field of SCOPE_FIELDS) {
    const value = scope[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `Memory scope field "${field}" must be a non-empty string when provided`
      );
    }
  }

  if (!scope.tenantId || scope.tenantId.trim().length === 0) {
    throw new Error("Memory scope requires tenantId");
  }
}

export function validateNamespace(namespace: string): void {
  if (namespace.trim().length === 0) {
    throw new Error("Memory namespace must be non-empty");
  }
}

export function validateRecord(
  record: MemoryRecord,
  namespace: string,
  scope: MemoryScope
): void {
  if (record.namespace !== namespace) {
    throw new Error(
      `Memory record namespace mismatch: expected "${namespace}", got "${record.namespace}"`
    );
  }

  validateScope(record.scope);

  if (record.scope.tenantId !== scope.tenantId) {
    throw new Error(
      "Memory record scope tenantId must match request scope tenantId"
    );
  }
}

export function validateQuery(query?: MemoryQuery): void {
  if (!query) return;

  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 0)
  ) {
    throw new Error(
      "Memory query limit must be a non-negative integer when provided"
    );
  }
  if (
    query.offset !== undefined &&
    (!Number.isInteger(query.offset) || query.offset < 0)
  ) {
    throw new Error(
      "Memory query offset must be a non-negative integer when provided"
    );
  }
  if (query.search !== undefined && typeof query.search !== "string") {
    throw new Error("Memory query search must be a string when provided");
  }
}
