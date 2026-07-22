/**
 * MCP server lifecycle management routes.
 *
 * POST   /servers           — Add a new MCP server definition (201)
 * GET    /servers           — List registered MCP servers
 * GET    /servers/:id       — Get a single MCP server (404 if missing)
 * PATCH  /servers/:id       — Update an MCP server definition
 * DELETE /servers/:id       — Remove an MCP server (204)
 * POST   /servers/:id/enable  — Enable a disabled server
 * POST   /servers/:id/disable — Disable an enabled server
 * POST   /servers/:id/test    — Test connectivity to an MCP server
 *
 * GET    /profiles          — List MCP profiles
 * POST   /profiles          — Create an MCP profile (201)
 * GET    /profiles/:id      — Get a single profile
 * DELETE /profiles/:id      — Remove an MCP profile (204)
 *
 * This file is a thin composition root — implementations live in:
 *   - `./mcp-helpers`  — pure redaction, payload-size validation, transport/
 *                        argument policy checks, and the forbidden-command
 *                        error envelope
 *   - `./mcp-handlers` — the Hono route handlers (`registerMcpHandlers`)
 *
 * ARCH-M-06: decomposed from a former single-file god-module that fused
 * response redaction, validation, error mapping, and route wiring. The
 * `createMcpRoutes` public surface is preserved exactly so callers keep
 * importing from `./routes/mcp`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { ForgeServerConfig } from "../composition/types.js";
import { registerMcpHandlers } from "./mcp-handlers.js";

export function createMcpRoutes(
  config: Pick<
    ForgeServerConfig,
    | "mcpManager"
    | "mcpAllowedExecutables"
    | "mcpStdioArgPolicy"
    | "mcpAllowedHttpHosts"
  >
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Guard: return 503 if mcpManager is not configured (checked per-request).
  // This runs before any handler, so handlers may safely assume `mcpManager`.
  app.use("*", async (c, next) => {
    if (!config.mcpManager) {
      return c.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "MCP manager not configured",
          },
        },
        503
      );
    }
    return next();
  });

  registerMcpHandlers(app, config);

  return app;
}
