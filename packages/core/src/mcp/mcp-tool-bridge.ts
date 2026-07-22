/**
 * MCP ↔ LangChain tool bridge.
 *
 * Converts MCP tool descriptors to LangChain StructuredToolInterface
 * and vice versa. Enables MCP tools to be used seamlessly in LangGraph
 * agent loops.
 */
import { type z } from "zod";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { PromptInjectionGuard } from "@dzupagent/security";
import type { MCPClient } from "./mcp-client.js";
import type { MCPToolDescriptor, MCPToolParameter } from "./mcp-types.js";
import { buildInputSchema } from "./mcp-input-schema.js";

/**
 * AGENT-M-16 — process-wide guard used to fence untrusted MCP result text at
 * the source (this bridge is a direct-invoke path that bypasses the agent
 * tool loop's AGENT-H-06 wrap). The guard is stateless, so one shared instance
 * is safe. Double-fencing with the tool-loop wrap is idempotent-harmless.
 */
const MCP_RESULT_GUARD = new PromptInjectionGuard();

// ---------------------------------------------------------------------------
// MCP → LangChain
// ---------------------------------------------------------------------------

/**
 * Convert a single MCP tool descriptor to a LangChain tool.
 * The tool's execute function calls back to the MCPClient.
 */
export function mcpToolToLangChain(
  descriptor: MCPToolDescriptor,
  client: MCPClient
): StructuredToolInterface {
  const inputSchema = buildInputSchema(descriptor);

  return tool(
    async (args) => {
      const result = await client.invokeTool(descriptor.name, args);

      if (result.isError) {
        const errorText = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        return `Error: ${errorText}`;
      }

      const text = result.content
        .map((c) => {
          if (c.type === "text") return c.text ?? "";
          if (c.type === "image") return `[Image: ${c.mimeType ?? "unknown"}]`;
          if (c.type === "resource")
            return `[Resource: ${c.mimeType ?? "unknown"}]`;
          return "";
        })
        .join("\n");

      // AGENT-M-16 — fence untrusted MCP server output so direct-invoke
      // consumers (outside the agent tool loop) inherit the same
      // <untrusted_content source="tool_result"> boundary the tool loop
      // applies via AGENT-H-06. Idempotent with that wrap.
      return MCP_RESULT_GUARD.wrap(text, { label: "tool_result" });
    },
    {
      name: descriptor.name,
      description: descriptor.description,
      schema: inputSchema,
    }
  );
}

/**
 * Convert all eagerly-loaded MCP tools to LangChain tools.
 */
export function mcpToolsToLangChain(
  client: MCPClient
): StructuredToolInterface[] {
  return client
    .getEagerTools()
    .map((descriptor) => mcpToolToLangChain(descriptor, client));
}

// ---------------------------------------------------------------------------
// LangChain → MCP (for exposing agents as MCP servers)
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema to a simplified JSON Schema for MCP.
 * Uses zodToJsonSchema from the schema's toJsonSchema() if available,
 * otherwise falls back to simple type string.
 */
function descriptionPart(
  schema: z.ZodType
): { description: string } | Record<string, never> {
  return schema.description !== undefined
    ? { description: schema.description }
    : {};
}

function zodToJsonSchema(schema: z.ZodType): MCPToolParameter {
  // Use Zod's built-in JSON Schema conversion when available
  const def = (schema as unknown as Record<string, unknown>)["_zod"] as
    | {
        def?: {
          type?: string;
          innerType?: z.ZodType;
          values?: string[];
          element?: z.ZodType;
          shape?: Record<string, z.ZodType>;
        };
      }
    | undefined;

  const typeName = def?.def?.type;

  // Unwrap optionals
  if (typeName === "optional" || typeName === "default") {
    const inner = def?.def?.innerType;
    if (inner) {
      const result = zodToJsonSchema(inner);
      return { ...result, required: false };
    }
  }

  if (typeName === "string") {
    return { type: "string", ...descriptionPart(schema) };
  }
  if (typeName === "number" || typeName === "int") {
    return { type: "number", ...descriptionPart(schema) };
  }
  if (typeName === "boolean") {
    return { type: "boolean", ...descriptionPart(schema) };
  }
  if (typeName === "array") {
    const element = def?.def?.element;
    return {
      type: "array",
      items: element ? zodToJsonSchema(element) : { type: "string" },
      ...descriptionPart(schema),
    };
  }
  if (typeName === "object") {
    const shape = def?.def?.shape;
    if (shape) {
      const properties: Record<string, MCPToolParameter> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
      }
      return { type: "object", properties, ...descriptionPart(schema) };
    }
    return { type: "object", ...descriptionPart(schema) };
  }
  if (typeName === "enum") {
    const values = def?.def?.values;
    return {
      type: "string",
      enum: (values as unknown[]) ?? [],
      ...descriptionPart(schema),
    };
  }

  // Fallback: try to infer from description
  return { type: "string", ...descriptionPart(schema) };
}

/**
 * Convert a LangChain tool to an MCP tool descriptor.
 */
export function langChainToolToMcp(
  langChainTool: StructuredToolInterface,
  serverId: string
): MCPToolDescriptor {
  const schema = langChainTool.schema as z.ZodObject<Record<string, z.ZodType>>;
  const shape = schema.shape as Record<string, z.ZodType>;
  const properties: Record<string, MCPToolParameter> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const param = zodToJsonSchema(value);
    properties[key] = param;
    if (param.required !== false) {
      required.push(key);
    }
  }

  return {
    name: langChainTool.name,
    description: langChainTool.description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 && { required }),
    },
    serverId,
  };
}
