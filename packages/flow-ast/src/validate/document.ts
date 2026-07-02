import type {
  FlowDocumentPolicy,
  FlowDocumentV1,
  FlowDurabilityPolicy,
} from "../types.js";
import {
  describeJsType,
  isFlowValue,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { validateCanonicalNodeIds } from "../validation-traversal.js";
import {
  validateOptionalObjectField,
  validateOptionalStringArrayField,
  validateOptionalStringField,
} from "./shared.js";
import type { SchemaIssue } from "./shared.js";
import { validateFlowNode } from "./dispatch.js";

export function validateFlowDocument(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1 | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `Expected workflow document object, received ${describeJsType(value)}`,
    });
    return null;
  }

  const dsl = value["dsl"];
  if (dsl !== "dzupflow/v1" && dsl !== "dzupflow/v1alpha-agent") {
    issues.push({
      path: joinPath(path, "dsl"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.dsl must equal "dzupflow/v1" or "dzupflow/v1alpha-agent", received ${describeJsType(dsl) === "string" ? JSON.stringify(dsl) : describeJsType(dsl)}`,
    });
  }

  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    issues.push({
      path: joinPath(path, "id"),
      code: "MISSING_REQUIRED_FIELD",
      message: "document.id is required (non-empty string)",
    });
  }

  const version = value["version"];
  if (!Number.isInteger(version) || (version as number) <= 0) {
    issues.push({
      path: joinPath(path, "version"),
      code: "MISSING_REQUIRED_FIELD",
      message: "document.version is required (positive integer)",
    });
  }

  const title = validateOptionalStringField(value, path, "title", issues);
  const description = validateOptionalStringField(
    value,
    path,
    "description",
    issues,
  );
  const tags = validateOptionalStringArrayField(value, path, "tags", issues);
  const meta = validateOptionalObjectField(value, path, "meta", issues);
  const inputs = validateOptionalInputs(value, path, issues);
  const defaults = validateOptionalDefaults(value, path, issues);
  const policy = validateOptionalDocumentPolicy(value, path, issues);
  const durability = validateOptionalDurability(value, path, issues);

  const rootNode = validateFlowNode(
    value["root"],
    joinPath(path, "root"),
    issues,
  );
  if (rootNode === null) return null;
  if (rootNode.type !== "sequence") {
    issues.push({
      path: joinPath(path, "root"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.root must be a sequence node, received ${rootNode.type}`,
    });
    return null;
  }

  validateCanonicalNodeIds(
    rootNode,
    joinPath(path, "root"),
    issues,
    new Map<string, string>(),
  );

  const doc: FlowDocumentV1 = {
    dsl:
      dsl === "dzupflow/v1alpha-agent"
        ? "dzupflow/v1alpha-agent"
        : "dzupflow/v1",
    id: typeof id === "string" ? id : "",
    version: Number.isInteger(version) ? (version as number) : 0,
    root: rootNode,
  };
  if (title !== undefined) doc.title = title;
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  if (meta !== undefined) doc.meta = meta;
  if (inputs !== undefined) doc.inputs = inputs;
  if (defaults !== undefined) doc.defaults = defaults;
  if (policy !== undefined) doc.policy = policy;
  if (durability !== undefined) doc.durability = durability;
  return doc;
}

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

function validateOptionalDurability(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDurabilityPolicy | undefined {
  if (!("durability" in obj) || obj["durability"] === undefined)
    return undefined;
  const value = obj["durability"];
  const base = joinPath(path, "durability");
  if (!isPlainObject(value)) {
    issues.push({
      path: base,
      code: "MISSING_REQUIRED_FIELD",
      message: `document.durability must be an object when present, received ${describeJsType(value)}`,
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
        message: `document.durability.mode must be one of ${DURABILITY_MODES.join("|")} when present`,
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
            message: `document.durability.checkpoint.strategy must be one of ${CHECKPOINT_STRATEGIES.join("|")} when present`,
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
              "includeProviderSessionRefs",
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
            if (typeof ttlMs === "number" && Number.isInteger(ttlMs) && ttlMs >= 0) {
              retention.ttlMs = ttlMs;
            } else {
              issues.push({
                path: joinPath(
                  joinPath(joinPath(base, "checkpoint"), "retention"),
                  "ttlMs",
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
                  "maxVersions",
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
            message: `document.durability.resume.onProcessRestart must be one of ${RESUME_ON_RESTART.join("|")} when present`,
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
            message: `document.durability.executionLog.eventHistory must be one of ${EXECUTION_LOG_HISTORY.join("|")} when present`,
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

function validateOptionalDocumentPolicy(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentPolicy | undefined {
  if (!("policy" in obj) || obj["policy"] === undefined) return undefined;
  const value = obj["policy"];
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, "policy"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.policy must be an object when present, received ${describeJsType(value)}`,
    });
    return undefined;
  }

  const policy: FlowDocumentPolicy = {};

  if ("budgetCents" in value && value["budgetCents"] !== undefined) {
    const v = value["budgetCents"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "budgetCents"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.policy.budgetCents must be a finite number when present",
      });
    } else if (v <= 0) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "budgetCents"),
        code: "MISSING_REQUIRED_FIELD",
        message: "document.policy.budgetCents must be greater than 0",
      });
    } else {
      policy.budgetCents = v;
    }
  }

  if ("timeoutMs" in value && value["timeoutMs"] !== undefined) {
    const v = value["timeoutMs"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.policy.timeoutMs must be a finite number when present",
      });
    } else if (v <= 0) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: "document.policy.timeoutMs must be greater than 0",
      });
    } else {
      policy.timeoutMs = v;
    }
  }

  if ("workingDirectory" in value && value["workingDirectory"] !== undefined) {
    const v = value["workingDirectory"];
    if (typeof v !== "string") {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "workingDirectory"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.policy.workingDirectory must be a string when present",
      });
    } else {
      policy.workingDirectory = v;
    }
  }

  return policy;
}

function validateOptionalInputs(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1["inputs"] | undefined {
  if (!("inputs" in obj) || obj["inputs"] === undefined) return undefined;
  const value = obj["inputs"];
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, "inputs"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.inputs must be an object when present, received ${describeJsType(value)}`,
    });
    return undefined;
  }

  const inputs: NonNullable<FlowDocumentV1["inputs"]> = {};
  for (const [key, rawSpec] of Object.entries(value)) {
    if (!isPlainObject(rawSpec)) {
      issues.push({
        path: joinPath(joinPath(path, "inputs"), key),
        code: "MISSING_REQUIRED_FIELD",
        message: "input spec must be an object",
      });
      continue;
    }

    const type = rawSpec["type"];
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "object" &&
      type !== "array" &&
      type !== "any"
    ) {
      issues.push({
        path: joinPath(joinPath(joinPath(path, "inputs"), key), "type"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "input spec.type must be one of string|number|boolean|object|array|any",
      });
      continue;
    }

    const spec: NonNullable<FlowDocumentV1["inputs"]>[string] = { type };
    if ("required" in rawSpec && rawSpec["required"] !== undefined) {
      if (typeof rawSpec["required"] === "boolean")
        spec.required = rawSpec["required"];
      else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, "inputs"), key), "required"),
          code: "MISSING_REQUIRED_FIELD",
          message: "input spec.required must be a boolean when present",
        });
      }
    }
    if ("description" in rawSpec && rawSpec["description"] !== undefined) {
      if (typeof rawSpec["description"] === "string")
        spec.description = rawSpec["description"];
      else {
        issues.push({
          path: joinPath(
            joinPath(joinPath(path, "inputs"), key),
            "description",
          ),
          code: "MISSING_REQUIRED_FIELD",
          message: "input spec.description must be a string when present",
        });
      }
    }
    if ("default" in rawSpec && rawSpec["default"] !== undefined) {
      if (isFlowValue(rawSpec["default"])) {
        spec.default = rawSpec["default"];
      } else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, "inputs"), key), "default"),
          code: "MISSING_REQUIRED_FIELD",
          message: "input spec.default must be a JSON-like value when present",
        });
      }
    }
    inputs[key] = spec;
  }
  return inputs;
}

function validateOptionalDefaults(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1["defaults"] | undefined {
  if (!("defaults" in obj) || obj["defaults"] === undefined) return undefined;
  const value = obj["defaults"];
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, "defaults"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.defaults must be an object when present, received ${describeJsType(value)}`,
    });
    return undefined;
  }

  const defaults: NonNullable<FlowDocumentV1["defaults"]> = {};
  if ("personaRef" in value && value["personaRef"] !== undefined) {
    if (typeof value["personaRef"] === "string")
      defaults.personaRef = value["personaRef"];
    else {
      issues.push({
        path: joinPath(joinPath(path, "defaults"), "personaRef"),
        code: "MISSING_REQUIRED_FIELD",
        message: "defaults.personaRef must be a string when present",
      });
    }
  }
  if ("timeoutMs" in value && value["timeoutMs"] !== undefined) {
    if (
      typeof value["timeoutMs"] === "number" &&
      Number.isFinite(value["timeoutMs"]) &&
      value["timeoutMs"] > 0
    ) {
      defaults.timeoutMs = value["timeoutMs"];
    } else {
      issues.push({
        path: joinPath(joinPath(path, "defaults"), "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: "defaults.timeoutMs must be a positive number when present",
      });
    }
  }
  if ("retry" in value && value["retry"] !== undefined) {
    const retry = value["retry"];
    if (isPlainObject(retry)) {
      const attempts = retry["attempts"];
      if (
        typeof attempts === "number" &&
        Number.isInteger(attempts) &&
        attempts > 0
      ) {
        defaults.retry = { attempts };
        const delayMs = retry["delayMs"];
        if (delayMs !== undefined) {
          if (
            typeof delayMs === "number" &&
            Number.isFinite(delayMs) &&
            delayMs >= 0
          ) {
            defaults.retry.delayMs = delayMs;
          } else {
            issues.push({
              path: joinPath(
                joinPath(joinPath(path, "defaults"), "retry"),
                "delayMs",
              ),
              code: "MISSING_REQUIRED_FIELD",
              message:
                "defaults.retry.delayMs must be a non-negative number when present",
            });
          }
        }
      } else {
        issues.push({
          path: joinPath(
            joinPath(joinPath(path, "defaults"), "retry"),
            "attempts",
          ),
          code: "MISSING_REQUIRED_FIELD",
          message: "defaults.retry.attempts must be a positive integer",
        });
      }
    } else {
      issues.push({
        path: joinPath(joinPath(path, "defaults"), "retry"),
        code: "MISSING_REQUIRED_FIELD",
        message: "defaults.retry must be an object when present",
      });
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : {};
}
