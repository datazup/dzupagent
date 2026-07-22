import type { FlowDocumentV1 } from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { validateCanonicalNodeIds } from "../validation-traversal.js";
import { validateSpddNodeOrdering } from "../validation-ordering.js";
import {
  validateOptionalObjectField,
  validateOptionalStringArrayField,
  validateOptionalStringField,
} from "./shared.js";
import type { SchemaIssue } from "./shared.js";
import { validateFlowNode } from "./dispatch.js";
import { validateOptionalDurability } from "./document/durability.js";
import { validateOptionalDocumentPolicy } from "./document/policy.js";
import { validateOptionalInputs } from "./document/inputs.js";
import { validateOptionalDefaults } from "./document/defaults.js";

export function validateFlowDocument(
  value: unknown,
  path: string,
  issues: SchemaIssue[]
): FlowDocumentV1 | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `Expected workflow document object, received ${describeJsType(
        value
      )}`,
    });
    return null;
  }

  const dsl = value["dsl"];
  if (dsl !== "dzupflow/v1" && dsl !== "dzupflow/v1alpha-agent") {
    issues.push({
      path: joinPath(path, "dsl"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.dsl must equal "dzupflow/v1" or "dzupflow/v1alpha-agent", received ${
        describeJsType(dsl) === "string"
          ? JSON.stringify(dsl)
          : describeJsType(dsl)
      }`,
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
    issues
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
    issues
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
    new Map<string, string>()
  );

  validateSpddNodeOrdering(rootNode, joinPath(path, "root"), issues);
  if (issues.some((i) => i.code === "SPDD_ORDERING_VIOLATION")) return null;

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
