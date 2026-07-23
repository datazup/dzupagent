import type {
  HttpNode,
  PromptNode,
  ReturnToNode,
  SubflowNode,
  WaitNode,
} from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";

// ── http ──────────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const HTTP_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "url",
  "method",
  "headers",
  "body",
  "auth",
  "outputVar",
  "output_var",
]);

export function normalizeHttp(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): HttpNode {
  reportUnsupportedFields(raw, HTTP_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const url = typeof raw.url === "string" ? raw.url : "";
  if (url.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "http.url is required",
      path: `${path}.url`,
    });
  }

  const node: HttpNode = { type: "http", ...base, url };

  if (raw.method !== undefined) {
    if (typeof raw.method === "string" && HTTP_METHODS.has(raw.method)) {
      node.method = raw.method as HttpNode["method"];
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "http.method must be GET|POST|PUT|PATCH|DELETE",
        path: `${path}.method`,
      });
    }
  }

  if (raw.headers !== undefined) {
    const h = normalizeObject(raw.headers, `${path}.headers`, diagnostics);
    if (h !== undefined) node.headers = h as Record<string, string>;
  }

  if (raw.body !== undefined) {
    const b = normalizeObject(raw.body, `${path}.body`, diagnostics);
    if (b !== undefined) node.body = b;
  }

  if (raw.auth !== undefined) {
    const auth = normalizeObject(raw.auth, `${path}.auth`, diagnostics);
    if (auth !== undefined) {
      const scheme = auth.scheme;
      const credential = auth.credential;
      const provider = auth.provider;
      const scopes = auth.scopes;
      const headerName = auth.headerName ?? auth.header_name;
      if (
        (scheme !== "bearer" &&
          scheme !== "basic" &&
          scheme !== "api-key-header") ||
        typeof credential !== "string" ||
        credential.length === 0 ||
        typeof provider !== "string" ||
        provider.length === 0 ||
        !Array.isArray(scopes) ||
        scopes.some((scope) => typeof scope !== "string")
      ) {
        diagnostics.push({
          phase: "normalize",
          code: DSL_ERROR.INVALID_NODE_SHAPE,
          message:
            "http.auth requires scheme, credential, provider, and string scopes",
          path: `${path}.auth`,
        });
      } else {
        node.auth = {
          scheme,
          credential,
          provider,
          scopes: scopes as string[],
          ...(typeof headerName === "string" ? { headerName } : {}),
        };
      }
    }
  }

  const outputVarRaw = raw.outputVar ?? raw.output_var;
  if (typeof outputVarRaw === "string") node.outputVar = outputVarRaw;

  return node;
}

// ── wait ──────────────────────────────────────────────────────────────────────

const WAIT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "durationMs",
  "duration_ms",
]);

export function normalizeWait(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): WaitNode {
  reportUnsupportedFields(raw, WAIT_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const durationRaw = raw.durationMs ?? raw.duration_ms;
  const durationMs = typeof durationRaw === "number" ? durationRaw : -1;

  if (durationMs < 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "wait.durationMs is required (non-negative number)",
      path: `${path}.durationMs`,
    });
  }

  return { type: "wait", ...base, durationMs: Math.max(0, durationMs) };
}

// ── subflow ───────────────────────────────────────────────────────────────────

const SUBFLOW_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "flowRef",
  "flow_ref",
  "input",
  "outputVar",
  "output_var",
]);

export function normalizeSubflow(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SubflowNode {
  reportUnsupportedFields(raw, SUBFLOW_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const flowRef =
    typeof raw.flowRef === "string"
      ? raw.flowRef
      : typeof raw.flow_ref === "string"
      ? raw.flow_ref
      : "";

  if (flowRef.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "subflow.flowRef is required",
      path: `${path}.flowRef`,
    });
  }

  const node: SubflowNode = { type: "subflow", ...base, flowRef };

  const input = normalizeObject(raw.input, `${path}.input`, diagnostics);
  if (input !== undefined) node.input = input;

  const outputVarRaw = raw.outputVar ?? raw.output_var;
  if (typeof outputVarRaw === "string") node.outputVar = outputVarRaw;

  return node;
}

// ── prompt ────────────────────────────────────────────────────────────────────

const PROMPT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "userPrompt",
  "user_prompt",
  "systemPrompt",
  "system_prompt",
  "outputKey",
  "output_key",
  "provider",
  "model",
  "tools",
]);

export function normalizePrompt(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): PromptNode {
  reportUnsupportedFields(raw, PROMPT_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const userPrompt =
    typeof raw.userPrompt === "string"
      ? raw.userPrompt
      : typeof raw.user_prompt === "string"
      ? raw.user_prompt
      : "";

  if (userPrompt.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "prompt.userPrompt is required",
      path: `${path}.userPrompt`,
    });
  }

  const node: PromptNode = { type: "prompt", ...base, userPrompt };

  const systemPromptRaw = raw.systemPrompt ?? raw.system_prompt;
  if (typeof systemPromptRaw === "string") node.systemPrompt = systemPromptRaw;

  const outputKeyRaw = raw.outputKey ?? raw.output_key;
  if (typeof outputKeyRaw === "string") node.outputKey = outputKeyRaw;

  if (typeof raw.provider === "string") node.provider = raw.provider;
  if (typeof raw.model === "string") node.model = raw.model;
  if (typeof raw.tools === "boolean") node.tools = raw.tools;

  return node;
}

// ── return_to ─────────────────────────────────────────────────────────────────

const RETURN_TO_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "targetId",
  "target_id",
  "condition",
  "maxIterations",
  "max_iterations",
]);

export function normalizeReturnTo(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): ReturnToNode {
  reportUnsupportedFields(raw, RETURN_TO_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const targetId =
    typeof raw.targetId === "string"
      ? raw.targetId
      : typeof raw.target_id === "string"
      ? raw.target_id
      : "";

  if (targetId.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "return_to.targetId is required",
      path: `${path}.targetId`,
    });
  }

  const condition = typeof raw.condition === "string" ? raw.condition : "";
  if (condition.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "return_to.condition is required",
      path: `${path}.condition`,
    });
  }

  const node: ReturnToNode = {
    type: "return_to",
    ...base,
    targetId,
    condition,
  };

  const maxIterRaw = raw.maxIterations ?? raw.max_iterations;
  if (typeof maxIterRaw === "number" && maxIterRaw > 0)
    node.maxIterations = maxIterRaw;

  return node;
}
