import type {
  AgentResult,
  AgentRunInput,
  AgentRunRequest,
  AgentRunScopeFile,
  AgentUsage,
} from "@dzupagent/dialogue-core";

import type { RecordedAgentCall } from "./recorded-agent-port.js";
import type { GoldenTraceDecodeContext } from "./golden-trace-decode-context.js";
import { decodeDialogueMode, decodeTurnVerb } from "./golden-trace-run-spec-decoder.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalValue,
  requiredString,
} from "./golden-trace-schema-helpers.js";

export function decodeRecordedAgentCall(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): RecordedAgentCall {
  return context.record(
    value,
    path,
    depth,
    ["result"],
    ["request"],
    (record) => {
      const request = optionalValue(
        context,
        record,
        "request",
        path,
        depth,
        decodeAgentRunRequest,
      );
      const result = decodeAgentResult(
        context,
        context.required(record, "result", path),
        `${path}.result`,
        depth + 1,
      );
      return {
        ...(request === undefined ? {} : { request }),
        result,
      };
    },
  );
}

function decodeAgentRunRequest(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): AgentRunRequest {
  return context.record(
    value,
    path,
    depth,
    [
      "runId",
      "runSpecHash",
      "turnIndex",
      "turnType",
      "participantId",
      "mode",
      "input",
    ],
    ["provider", "model", "escape"],
    (record) => {
      const runId = requiredString(context, record, "runId", path, depth);
      const runSpecHash = context.runSpecHash(
        context.required(record, "runSpecHash", path),
        `${path}.runSpecHash`,
        depth + 1,
      );
      const turnIndex = context.number(
        context.required(record, "turnIndex", path),
        `${path}.turnIndex`,
        depth + 1,
        "non-negative-integer",
      );
      const turnType = decodeTurnVerb(
        context,
        context.required(record, "turnType", path),
        `${path}.turnType`,
        depth + 1,
      );
      const participantId = requiredString(
        context,
        record,
        "participantId",
        path,
        depth,
      );
      const mode = decodeDialogueMode(
        context,
        context.required(record, "mode", path),
        `${path}.mode`,
        depth + 1,
      );
      const input = decodeAgentRunInput(
        context,
        context.required(record, "input", path),
        `${path}.input`,
        depth + 1,
      );
      const provider = optionalString(
        context,
        record,
        "provider",
        path,
        depth,
      );
      const model = optionalString(context, record, "model", path, depth);
      const escape = optionalBoolean(
        context,
        record,
        "escape",
        path,
        depth,
      );
      return {
        runId,
        runSpecHash,
        turnIndex,
        turnType,
        participantId,
        mode,
        input,
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(escape === undefined ? {} : { escape }),
      };
    },
  );
}

function decodeAgentRunInput(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): AgentRunInput {
  return context.record(
    value,
    path,
    depth,
    ["prompt"],
    ["role", "systemPrompt", "scopeFiles"],
    (record) => {
      const prompt = requiredString(
        context,
        record,
        "prompt",
        path,
        depth,
      );
      const role = optionalString(context, record, "role", path, depth);
      const systemPrompt = optionalString(
        context,
        record,
        "systemPrompt",
        path,
        depth,
      );
      const scopeFiles = record.has("scopeFiles")
        ? context.array(
            record.get("scopeFiles"),
            `${path}.scopeFiles`,
            depth + 1,
            (item, itemPath, itemDepth) =>
              decodeAgentScopeFile(context, item, itemPath, itemDepth),
          )
        : undefined;
      return {
        prompt,
        ...(role === undefined ? {} : { role }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(scopeFiles === undefined ? {} : { scopeFiles }),
      };
    },
  );
}

function decodeAgentScopeFile(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): AgentRunScopeFile {
  return context.record(
    value,
    path,
    depth,
    ["path"],
    ["content"],
    (record) => {
      const filePath = requiredString(
        context,
        record,
        "path",
        path,
        depth,
      );
      const content = optionalString(
        context,
        record,
        "content",
        path,
        depth,
      );
      return {
        path: filePath,
        ...(content === undefined ? {} : { content }),
      };
    },
  );
}

function decodeAgentResult(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): AgentResult {
  return context.record(
    value,
    path,
    depth,
    ["raw"],
    ["usage"],
    (record) => {
      const raw = requiredString(context, record, "raw", path, depth);
      const usage = optionalValue(
        context,
        record,
        "usage",
        path,
        depth,
        decodeAgentUsage,
      );
      return {
        raw,
        ...(usage === undefined ? {} : { usage }),
      };
    },
  );
}

function decodeAgentUsage(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): AgentUsage {
  return context.record(
    value,
    path,
    depth,
    [],
    ["inputTokens", "outputTokens", "totalTokens"],
    (record) => {
      const inputTokens = optionalNumber(
        context,
        record,
        "inputTokens",
        path,
        depth,
        "non-negative-integer",
      );
      const outputTokens = optionalNumber(
        context,
        record,
        "outputTokens",
        path,
        depth,
        "non-negative-integer",
      );
      const totalTokens = optionalNumber(
        context,
        record,
        "totalTokens",
        path,
        depth,
        "non-negative-integer",
      );
      return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
      };
    },
  );
}
