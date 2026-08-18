import { createHash } from "node:crypto";
import type {
  AgentTask,
  RoutingTaskInput,
} from "../routing-policy-types.js";

export const ROUTING_KEYWORD_TAG_MAP: ReadonlyMap<
  string,
  readonly string[]
> = new Map([
  ["database", ["database", "db", "sql", "schema", "migration"]],
  ["api", ["api", "backend", "rest", "endpoint", "route", "server"]],
  ["ui", ["ui", "frontend", "component", "page", "view", "css", "style"]],
  ["test", ["test", "testing", "spec", "coverage", "assertion"]],
  [
    "security",
    ["security", "auth", "authentication", "authorization", "rbac"],
  ],
  ["deploy", ["deploy", "deployment", "ci", "cd", "infrastructure", "devops"]],
]);

interface BuildRoutingTaskOptions {
  scope: "supervisor" | "subtask";
  content: string;
  ordinal?: number;
  input?: RoutingTaskInput | undefined;
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function stableDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function derivedTags(content: string): string[] {
  const normalized = normalizeContent(content);
  const tags: string[] = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];

  for (const [tag, keywords] of ROUTING_KEYWORD_TAG_MAP) {
    if (keywords.some((keyword) => tags.includes(keyword))) {
      tags.push(tag);
    }
  }

  return tags;
}

function resolveTaskId({
  scope,
  content,
  ordinal,
  input,
}: BuildRoutingTaskOptions): string {
  const explicitTaskId = input?.taskId;
  if (explicitTaskId !== undefined && explicitTaskId.trim().length === 0) {
    throw new RangeError("routing taskId must be non-blank when supplied");
  }

  const normalized = normalizeContent(content);
  const position = scope === "subtask" ? ordinal ?? 0 : 0;
  const digest = stableDigest(`${scope}\u0000${position}\u0000${normalized}`);

  if (scope === "supervisor") {
    return explicitTaskId ?? `supervisor-${digest}`;
  }

  return explicitTaskId
    ? `${explicitTaskId}:${position}:${digest}`
    : `subtask-${position}-${digest}`;
}

/** Build a stable, opaque task envelope for every production routing call. */
export function buildRoutingTask(options: BuildRoutingTaskOptions): AgentTask {
  const tags = [
    ...(options.input?.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    ...derivedTags(options.content),
  ];

  return {
    taskId: resolveTaskId(options),
    content: options.content,
    tags: [...new Set(tags)],
    ...(options.input?.metadata
      ? { metadata: options.input.metadata }
      : {}),
  };
}
