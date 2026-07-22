/**
 * Serialization helpers for persisting {@link RecoveryLesson}s to a
 * `BaseStore` and hydrating them back.
 *
 * Extracted from `recovery-feedback.ts` as part of the god-module
 * decomposition (DZUPAGENT-ARCH-M-06). Pure functions, no I/O.
 *
 * @module self-correction/recovery-feedback/recovery-feedback-serialization
 */

import type { FailureType } from "../../recovery/recovery-types.js";
import type { RecoveryLesson } from "../recovery-lesson-types.js";

/**
 * Stored representation of a {@link RecoveryLesson}.
 *
 * Declared as a type alias of an index-signature record so it satisfies the
 * `Record<string, unknown>` shape required by `BaseStore.put` without any
 * unchecked cast at the call site.
 */
export type SerializedLesson = Record<string, unknown> & {
  id: string;
  errorType: string;
  errorFingerprint: string;
  nodeId: string;
  strategy: string;
  outcome: "success" | "failure";
  summary: string;
  timestamp: string;
  tenantId?: string | null;
};

/**
 * Type guard that narrows an arbitrary store value to a record we can read
 * lesson fields from. Callers index this record with optional checks (e.g.
 * `value.id`, `value.outcome`) instead of trusting a wide cast.
 */
export function isLessonRecord(
  value: unknown
): value is Partial<SerializedLesson> {
  return typeof value === "object" && value !== null;
}

/**
 * Best-effort hydration of a stored value into a fully-shaped
 * `RecoveryLesson`. Missing string fields fall back to empty strings to
 * preserve the lenient behaviour of the original cast-based implementation.
 */
export function hydrateLesson(
  value: Partial<SerializedLesson>
): RecoveryLesson {
  return {
    id: value.id ?? "",
    errorType: (value.errorType ?? "") as FailureType,
    errorFingerprint: value.errorFingerprint ?? "",
    nodeId: value.nodeId ?? "",
    strategy: value.strategy ?? "",
    outcome: value.outcome === "failure" ? "failure" : "success",
    summary: value.summary ?? "",
    timestamp:
      typeof value.timestamp === "string"
        ? new Date(value.timestamp)
        : new Date(0),
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null,
  };
}

export function serializeLesson(lesson: RecoveryLesson): SerializedLesson {
  return {
    id: lesson.id,
    errorType: lesson.errorType,
    errorFingerprint: lesson.errorFingerprint,
    nodeId: lesson.nodeId,
    strategy: lesson.strategy,
    outcome: lesson.outcome,
    summary: lesson.summary,
    timestamp: lesson.timestamp.toISOString(),
    tenantId: lesson.tenantId ?? "default",
  };
}
