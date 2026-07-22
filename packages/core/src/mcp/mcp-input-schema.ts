/**
 * MCP tool inputSchema → Zod conversion.
 *
 * Extracted to a leaf module so both {@link file://./mcp-client.ts} (which
 * validates model-emitted args against the descriptor's declared inputSchema
 * before dispatching to the transport) and {@link file://./mcp-tool-bridge.ts}
 * (which attaches the schema to the LangChain wrapper) share one canonical
 * builder without creating an import cycle between them.
 */
import { z } from "zod";
import type { MCPToolDescriptor, MCPToolParameter } from "./mcp-types.js";

/**
 * Convert a JSON Schema property to a Zod schema.
 * Handles the common subset used by MCP tool input schemas.
 */
export function jsonSchemaToZod(param: MCPToolParameter): z.ZodType {
  switch (param.type) {
    case "string":
      if (param.enum && param.enum.length > 0) {
        return z.enum(param.enum as [string, ...string[]]);
      }
      return param.description
        ? z.string().describe(param.description)
        : z.string();

    case "number":
    case "integer":
      return param.description
        ? z.number().describe(param.description)
        : z.number();

    case "boolean":
      return param.description
        ? z.boolean().describe(param.description)
        : z.boolean();

    case "array":
      if (param.items) {
        return z.array(jsonSchemaToZod(param.items));
      }
      return z.array(z.unknown());

    case "object":
      if (param.properties) {
        const shape: Record<string, z.ZodType> = {};
        for (const [key, prop] of Object.entries(param.properties)) {
          shape[key] =
            prop.required === false
              ? jsonSchemaToZod(prop).optional()
              : jsonSchemaToZod(prop);
        }
        return z.object(shape);
      }
      return z.record(z.string(), z.unknown());

    default:
      return z.unknown();
  }
}

/**
 * Build a Zod object schema from an MCP tool's inputSchema.
 *
 * Required keys come from `inputSchema.required`; everything else is optional.
 * The object is intentionally NOT `.strict()`: unknown keys are stripped
 * (default Zod object behaviour) rather than rejected, matching the LangChain
 * wrapper's historical acceptance and avoiding false rejections against MCP
 * servers that tolerate extra fields. Wrong-typed and missing-required args
 * still fail `safeParse` (AGENT-H-07).
 */
export function buildInputSchema(
  descriptor: MCPToolDescriptor
): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  const required = new Set(descriptor.inputSchema.required ?? []);

  for (const [key, prop] of Object.entries(descriptor.inputSchema.properties)) {
    const zodType = jsonSchemaToZod(prop);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return z.object(shape);
}
