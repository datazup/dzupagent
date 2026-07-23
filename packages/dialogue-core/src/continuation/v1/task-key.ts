import { createHash } from "node:crypto";

import type { ContinuationTaskKeyV1 } from "./types.js";

export function normalizeContinuationTaskTextV1(task: string): string {
  return task.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function createContinuationTaskKeyV1(
  task: string
): ContinuationTaskKeyV1 {
  const normalized = normalizeContinuationTaskTextV1(task);
  const digest = createHash("sha256").update(normalized).digest("hex");

  return `task-key/v1:sha256:${digest}`;
}
