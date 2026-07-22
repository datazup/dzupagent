import type { McpServerDescriptor } from "@dzupagent/runtime-contracts";
import type { AgentInput } from "../../types.js";
import { policyRejected } from "./policy.js";

/**
 * Codex CLI external-tool (MCP) projection: reads the runtime MCP descriptors
 * off AgentInput.options, validates them against the CLI backend's transport
 * constraints (HTTP-only, no header materialization, bearer-env naming rules),
 * and renders the `[mcp_servers.*]` TOML block plus the bearer-token env map
 * that gets merged into the private CODEX_HOME config.toml. Extracted from the
 * adapter class because it is a cohesive descriptor->config translator with no
 * dependency on adapter instance state.
 */

export interface CodexMcpProjection {
  readonly config: string;
  readonly env: Readonly<Record<string, string>>;
}

export function readMcpDescriptors(
  input: AgentInput
): readonly McpServerDescriptor[] {
  const value = input.options?.["mcpServers"];
  return Array.isArray(value) ? (value as McpServerDescriptor[]) : [];
}

export function readMcpReferenceValues(
  input: AgentInput
): Readonly<Record<string, string>> {
  const value = input.options?.["mcpReferenceValues"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

export function validateCodexMcpDescriptors(input: AgentInput): void {
  for (const descriptor of readMcpDescriptors(input)) {
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      !/^[A-Za-z0-9_-]+$/u.test(descriptor.id)
    ) {
      throw policyRejected(
        "Codex MCP server ids must use letters, digits, underscore, or hyphen",
        "invalid_mcp_id"
      );
    }
    if (descriptor.transport?.kind !== "http") {
      throw policyRejected(
        `Codex CLI supports only HTTP MCP descriptors: ${descriptor.id}`,
        "unsupported_mcp_transport"
      );
    }
    const url = parseHttpUrl(descriptor.transport.url, descriptor.id);
    void url;
    if (descriptor.enabledTools?.length || descriptor.disabledTools?.length) {
      throw policyRejected(
        `Codex CLI tool-list projection is not verified for MCP server ${descriptor.id}`,
        "unsupported_mcp_tool_filter"
      );
    }
    if (
      descriptor.transport.headerRefs &&
      Object.keys(descriptor.transport.headerRefs).length > 0
    ) {
      throw policyRejected(
        `Codex CLI requires bearerTokenEnv instead of materialized HTTP headers for MCP server ${descriptor.id}`,
        "unsupported_mcp_headers"
      );
    }
    const bearer = descriptor.transport.bearerTokenEnv;
    if (
      bearer &&
      (!/^[A-Z][A-Z0-9_]*$/u.test(bearer.envVar) ||
        !/(?:TOKEN|AUTH|BEARER)/u.test(bearer.envVar) ||
        ["PATH", "HOME", "CODEX_HOME", "NODE_OPTIONS"].includes(bearer.envVar))
    ) {
      throw policyRejected(
        `Invalid bearer token environment variable for MCP server ${descriptor.id}`,
        "invalid_mcp_bearer_env"
      );
    }
  }
}

export function projectCodexMcp(input: AgentInput): CodexMcpProjection | null {
  const descriptors = readMcpDescriptors(input);
  if (descriptors.length === 0) return null;
  validateCodexMcpDescriptors(input);
  const refs = readMcpReferenceValues(input);
  const env: Record<string, string> = {};
  const blocks: string[] = [];

  for (const descriptor of descriptors) {
    const transport = descriptor.transport;
    if (transport.kind !== "http") continue;
    const lines = [
      `[mcp_servers.${JSON.stringify(descriptor.id)}]`,
      `url = ${JSON.stringify(
        parseHttpUrl(transport.url, descriptor.id).toString()
      )}`,
      "enabled = true",
      "required = true",
      'default_tools_approval_mode = "auto"',
    ];
    if (transport.bearerTokenEnv) {
      const { envVar, tokenRef } = transport.bearerTokenEnv;
      const token = refs[tokenRef];
      if (!token || /[\0\r\n]/u.test(token))
        throw policyRejected(
          `Unresolved or invalid MCP bearer token reference: ${tokenRef}`,
          "unresolved_mcp_bearer_ref"
        );
      if (env[envVar] !== undefined && env[envVar] !== token) {
        throw policyRejected(
          `Conflicting MCP bearer token values for environment variable: ${envVar}`,
          "conflicting_mcp_bearer_env"
        );
      }
      env[envVar] = token;
      lines.push(`bearer_token_env_var = ${JSON.stringify(envVar)}`);
    }
    blocks.push(lines.join("\n"));
  }
  return { config: `${blocks.join("\n\n")}\n`, env };
}

export function parseHttpUrl(value: string, id: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw policyRejected(`Invalid MCP URL for server ${id}`, "invalid_mcp_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw policyRejected(
      `MCP URL must use http or https for server ${id}`,
      "invalid_mcp_url"
    );
  }
  return url;
}
