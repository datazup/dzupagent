import type { FlowDurabilityPolicy } from "../../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../../validation-helpers.js";
import type { SchemaIssue } from "../shared.js";

const DURABILITY_MODES = ["volatile", "checkpointed", "durable"] as const;
const CHECKPOINT_STRATEGIES = [
  "explicit",
  "after_each_node",
  "after_each_effect",
  "after_each_branch",
] as const;
const RESUME_ON_RESTART = [
  "fail_running",
  "resume_from_checkpoint",
  "redeliver_running",
] as const;
const EXECUTION_LOG_HISTORY = ["none", "compact", "full"] as const;

export function validateOptionalDurability(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowDurabilityPolicy | undefined {
  if (!("durability" in obj) || obj["durability"] === undefined)
    return undefined;
  const value = obj["durability"];
  const base = joinPath(path, "durability");
  if (!isPlainObject(value)) {
    issues.push({
      path: base,
      code: "MISSING_REQUIRED_FIELD",
      message: `document.durability must be an object when present, received ${describeJsType(
        value
      )}`,
    });
    return undefined;
  }

  const durability: FlowDurabilityPolicy = {};

  if ("mode" in value && value["mode"] !== undefined) {
    const v = value["mode"];
    if (
      typeof v === "string" &&
      (DURABILITY_MODES as readonly string[]).includes(v)
    ) {
      durability.mode = v as FlowDurabilityPolicy["mode"];
    } else {
      issues.push({
        path: joinPath(base, "mode"),
        code: "MISSING_REQUIRED_FIELD",
        message: `document.durability.mode must be one of ${DURABILITY_MODES.join(
          "|"
        )} when present`,
      });
    }
  }

  if ("checkpoint" in value && value["checkpoint"] !== undefined) {
    const cp = value["checkpoint"];
    if (!isPlainObject(cp)) {
      issues.push({
        path: joinPath(base, "checkpoint"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.durability.checkpoint must be an object when present",
      });
    } else {
      const checkpoint: NonNullable<FlowDurabilityPolicy["checkpoint"]> = {};
      if ("strategy" in cp && cp["strategy"] !== undefined) {
        const s = cp["strategy"];
        if (
          typeof s === "string" &&
          (CHECKPOINT_STRATEGIES as readonly string[]).includes(s)
        ) {
          checkpoint.strategy = s as NonNullable<
            FlowDurabilityPolicy["checkpoint"]
          >["strategy"];
        } else {
          issues.push({
            path: joinPath(joinPath(base, "checkpoint"), "strategy"),
            code: "MISSING_REQUIRED_FIELD",
            message: `document.durability.checkpoint.strategy must be one of ${CHECKPOINT_STRATEGIES.join(
              "|"
            )} when present`,
          });
        }
      }
      if ("storeRef" in cp && cp["storeRef"] !== undefined) {
        if (typeof cp["storeRef"] === "string")
          checkpoint.storeRef = cp["storeRef"];
        else {
          issues.push({
            path: joinPath(joinPath(base, "checkpoint"), "storeRef"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.checkpoint.storeRef must be a string when present",
          });
        }
      }
      if ("includeEvents" in cp && cp["includeEvents"] !== undefined) {
        if (typeof cp["includeEvents"] === "boolean") {
          checkpoint.includeEvents = cp["includeEvents"];
        } else {
          issues.push({
            path: joinPath(joinPath(base, "checkpoint"), "includeEvents"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.checkpoint.includeEvents must be a boolean when present",
          });
        }
      }
      if (
        "includeProviderSessionRefs" in cp &&
        cp["includeProviderSessionRefs"] !== undefined
      ) {
        if (typeof cp["includeProviderSessionRefs"] === "boolean") {
          checkpoint.includeProviderSessionRefs =
            cp["includeProviderSessionRefs"];
        } else {
          issues.push({
            path: joinPath(
              joinPath(base, "checkpoint"),
              "includeProviderSessionRefs"
            ),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.checkpoint.includeProviderSessionRefs must be a boolean when present",
          });
        }
      }
      if ("retention" in cp && cp["retention"] !== undefined) {
        const retentionValue = cp["retention"];
        if (!isPlainObject(retentionValue)) {
          issues.push({
            path: joinPath(joinPath(base, "checkpoint"), "retention"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.checkpoint.retention must be an object when present",
          });
        } else {
          const retention: NonNullable<
            NonNullable<FlowDurabilityPolicy["checkpoint"]>["retention"]
          > = {};
          if (
            "ttlMs" in retentionValue &&
            retentionValue["ttlMs"] !== undefined
          ) {
            const ttlMs = retentionValue["ttlMs"];
            if (
              typeof ttlMs === "number" &&
              Number.isInteger(ttlMs) &&
              ttlMs >= 0
            ) {
              retention.ttlMs = ttlMs;
            } else {
              issues.push({
                path: joinPath(
                  joinPath(joinPath(base, "checkpoint"), "retention"),
                  "ttlMs"
                ),
                code: "MISSING_REQUIRED_FIELD",
                message:
                  "document.durability.checkpoint.retention.ttlMs must be a non-negative integer when present",
              });
            }
          }
          if (
            "maxVersions" in retentionValue &&
            retentionValue["maxVersions"] !== undefined
          ) {
            const maxVersions = retentionValue["maxVersions"];
            if (
              typeof maxVersions === "number" &&
              Number.isInteger(maxVersions) &&
              maxVersions > 0
            ) {
              retention.maxVersions = maxVersions;
            } else {
              issues.push({
                path: joinPath(
                  joinPath(joinPath(base, "checkpoint"), "retention"),
                  "maxVersions"
                ),
                code: "MISSING_REQUIRED_FIELD",
                message:
                  "document.durability.checkpoint.retention.maxVersions must be a positive integer when present",
              });
            }
          }
          if (Object.keys(retention).length > 0) {
            checkpoint.retention = retention;
          }
        }
      }
      if (Object.keys(checkpoint).length > 0)
        durability.checkpoint = checkpoint;
    }
  }

  if ("resume" in value && value["resume"] !== undefined) {
    const rs = value["resume"];
    if (!isPlainObject(rs)) {
      issues.push({
        path: joinPath(base, "resume"),
        code: "MISSING_REQUIRED_FIELD",
        message: "document.durability.resume must be an object when present",
      });
    } else {
      const resume: NonNullable<FlowDurabilityPolicy["resume"]> = {};
      if ("onProcessRestart" in rs && rs["onProcessRestart"] !== undefined) {
        const r = rs["onProcessRestart"];
        if (
          typeof r === "string" &&
          (RESUME_ON_RESTART as readonly string[]).includes(r)
        ) {
          resume.onProcessRestart = r as NonNullable<
            FlowDurabilityPolicy["resume"]
          >["onProcessRestart"];
        } else {
          issues.push({
            path: joinPath(joinPath(base, "resume"), "onProcessRestart"),
            code: "MISSING_REQUIRED_FIELD",
            message: `document.durability.resume.onProcessRestart must be one of ${RESUME_ON_RESTART.join(
              "|"
            )} when present`,
          });
        }
      }
      if (
        "requireResumePoint" in rs &&
        rs["requireResumePoint"] !== undefined
      ) {
        if (typeof rs["requireResumePoint"] === "boolean") {
          resume.requireResumePoint = rs["requireResumePoint"];
        } else {
          issues.push({
            path: joinPath(joinPath(base, "resume"), "requireResumePoint"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.resume.requireResumePoint must be a boolean when present",
          });
        }
      }
      if ("maxReplayNodes" in rs && rs["maxReplayNodes"] !== undefined) {
        const m = rs["maxReplayNodes"];
        if (typeof m === "number" && Number.isInteger(m) && m >= 0) {
          resume.maxReplayNodes = m;
        } else {
          issues.push({
            path: joinPath(joinPath(base, "resume"), "maxReplayNodes"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.resume.maxReplayNodes must be a non-negative integer when present",
          });
        }
      }
      if (Object.keys(resume).length > 0) durability.resume = resume;
    }
  }

  if ("executionLog" in value && value["executionLog"] !== undefined) {
    const rawExecutionLog = value["executionLog"];
    if (!isPlainObject(rawExecutionLog)) {
      issues.push({
        path: joinPath(base, "executionLog"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.durability.executionLog must be an object when present",
      });
    } else {
      const executionLog: NonNullable<FlowDurabilityPolicy["executionLog"]> =
        {};
      if (
        "storeRef" in rawExecutionLog &&
        rawExecutionLog["storeRef"] !== undefined
      ) {
        if (typeof rawExecutionLog["storeRef"] === "string") {
          executionLog.storeRef = rawExecutionLog["storeRef"];
        } else {
          issues.push({
            path: joinPath(joinPath(base, "executionLog"), "storeRef"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              "document.durability.executionLog.storeRef must be a string when present",
          });
        }
      }
      if (
        "eventHistory" in rawExecutionLog &&
        rawExecutionLog["eventHistory"] !== undefined
      ) {
        const history = rawExecutionLog["eventHistory"];
        if (
          typeof history === "string" &&
          (EXECUTION_LOG_HISTORY as readonly string[]).includes(history)
        ) {
          executionLog.eventHistory = history as NonNullable<
            FlowDurabilityPolicy["executionLog"]
          >["eventHistory"];
        } else {
          issues.push({
            path: joinPath(joinPath(base, "executionLog"), "eventHistory"),
            code: "MISSING_REQUIRED_FIELD",
            message: `document.durability.executionLog.eventHistory must be one of ${EXECUTION_LOG_HISTORY.join(
              "|"
            )} when present`,
          });
        }
      }
      if (Object.keys(executionLog).length > 0) {
        durability.executionLog = executionLog;
      }
    }
  }

  return durability;
}
