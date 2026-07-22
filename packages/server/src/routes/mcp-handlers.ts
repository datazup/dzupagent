/**
 * MCP server lifecycle route handlers, registered onto an existing Hono
 * instance by `createMcpRoutes` (`./mcp`).
 *
 * ARCH-M-06: extracted from the former single-file `./mcp` god-module. This
 * module owns the HTTP request/response wiring (route registration, status
 * codes, response shapes); pure validation, redaction, and error mapping live
 * in `./mcp-helpers`. The composition root in `./mcp` builds the app, installs
 * the mcpManager guard, and passes the resolved config slice here as deps, so
 * observable HTTP behaviour is unchanged.
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
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { ForgeServerConfig } from "../composition/types.js";
import { sanitizeError } from "./route-error.js";
import { McpServerSchema, validateBodyCompat } from "./schemas.js";
import type {
  McpServerInput,
  McpServerPatch,
  McpProfile,
} from "@dzupagent/core/pipeline";
import { assertMcpCommandAllowed } from "@dzupagent/core/pipeline";
import { secureLogger } from "@dzupagent/core/utils";
import { getSerializedJsonSizeBytes } from "../validation/route-validator.js";
import { getRequestingTenantId } from "./tenant-scope.js";
import {
  MCP_PROFILE_MAX_BYTES,
  forbiddenCommandResponse,
  getOversizedMcpServerField,
  redactMcpDefinition,
  validateHttpServerInput,
} from "./mcp-helpers.js";

/**
 * Config slice required by the MCP route handlers. Resolved by the composition
 * root in `./mcp`, which also guarantees `mcpManager` is configured (a `use("*")`
 * guard returns 503 before any handler runs, so `mcpManager!` is safe here).
 */
export type McpHandlerConfig = Pick<
  ForgeServerConfig,
  | "mcpManager"
  | "mcpAllowedExecutables"
  | "mcpStdioArgPolicy"
  | "mcpAllowedHttpHosts"
>;

export function registerMcpHandlers(
  app: Hono<AppEnv>,
  config: McpHandlerConfig
): void {
  // -------------------------------------------------------------------------
  // Server routes
  // -------------------------------------------------------------------------

  // GET /servers — list all servers
  app.get("/servers", async (c) => {
    const servers = await config.mcpManager!.listServers(
      getRequestingTenantId(c)
    );
    return c.json({
      data: servers.map(redactMcpDefinition),
      count: servers.length,
    });
  });

  // POST /servers — add a server
  app.post("/servers", async (c) => {
    const parsed = await validateBodyCompat(c, McpServerSchema);
    if (parsed instanceof Response) return parsed;
    // SEC-H-02: never trust a client-supplied tenantId; ownership is derived
    // from the authenticated caller and passed to the manager explicitly.
    const { tenantId: _ignoredTenantId, ...body }: McpServerInput = parsed;
    const tenantId = getRequestingTenantId(c);

    const oversizedServerField = getOversizedMcpServerField(body);
    if (oversizedServerField) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `${oversizedServerField} too large (max 64 KB)`,
          },
        },
        413
      );
    }

    // RF-S03: gate stdio transport registrations behind an explicit
    // allowlist so authenticated API keys cannot spawn arbitrary binaries
    // on the host. `endpoint` carries the command for stdio transports.
    if (body.transport === "stdio") {
      const allowedExes = config.mcpAllowedExecutables ?? [];
      if (!allowedExes.includes(body.endpoint)) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message:
                "stdio MCP server command not in allowlist. Set mcpAllowedExecutables in ForgeServerConfig.",
            },
          },
          403
        );
      }
      // SEC-H-02: even an allowlisted executable can achieve host RCE via
      // inline-eval arguments (`node -e …`, `bash -c …`, `npx <pkg>`). Reject
      // those under the strict policy (default).
      try {
        assertMcpCommandAllowed(
          body.endpoint,
          body.args,
          config.mcpStdioArgPolicy ?? "strict"
        );
      } catch (err) {
        return forbiddenCommandResponse(c, err);
      }
    }

    const urlPolicyError = await validateHttpServerInput(
      body,
      config.mcpAllowedHttpHosts
    );
    if (urlPolicyError) return urlPolicyError;

    try {
      const server = await config.mcpManager!.addServer(body, tenantId);
      return c.json({ data: redactMcpDefinition(server) }, 201);
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      if (internal.includes("already exists")) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: safe } },
          409
        );
      }
      throw err;
    }
  });

  // GET /servers/:id — get a server
  app.get("/servers/:id", async (c) => {
    const id = c.req.param("id");
    const server = await config.mcpManager!.getServer(
      id,
      getRequestingTenantId(c)
    );
    if (!server) {
      return c.json(
        {
          error: { code: "NOT_FOUND", message: `MCP server "${id}" not found` },
        },
        404
      );
    }
    return c.json({ data: redactMcpDefinition(server) });
  });

  // PATCH /servers/:id — update a server
  app.patch("/servers/:id", async (c) => {
    const id = c.req.param("id");
    const tenantId = getRequestingTenantId(c);
    let patch: McpServerPatch;
    try {
      const rawPatch = await c.req.json<McpServerPatch>();
      // SEC-H-02: a patch must not be able to re-assign tenant ownership.
      const { tenantId: _ignoredPatchTenant, ...rest } = rawPatch;
      patch = rest;
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } },
        400
      );
    }

    const oversizedPatchField = getOversizedMcpServerField(patch);
    if (oversizedPatchField) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `${oversizedPatchField} too large (max 64 KB)`,
          },
        },
        413
      );
    }

    const existing = await config.mcpManager!.getServer(id, tenantId);
    if (!existing) {
      return c.json(
        {
          error: { code: "NOT_FOUND", message: `MCP server "${id}" not found` },
        },
        404
      );
    }

    // MJ-SEC-03 / SEC-H-02: validate stdio executable allowlist and argument
    // policy on patch. A patch may change transport to stdio, change the
    // endpoint of an existing stdio server, or change only the args of an
    // existing stdio server (which can introduce an inline-eval RCE) — all
    // three must be gated.
    if (
      patch.transport === "stdio" ||
      patch.endpoint !== undefined ||
      patch.args !== undefined
    ) {
      const effectiveTransport = patch.transport ?? existing?.transport;
      if (effectiveTransport === "stdio") {
        const effectiveEndpoint = patch.endpoint ?? existing?.endpoint ?? "";
        const allowedExes = config.mcpAllowedExecutables ?? [];
        if (!allowedExes.includes(effectiveEndpoint)) {
          return c.json(
            {
              error: {
                code: "FORBIDDEN",
                message:
                  "stdio MCP server command not in allowlist. Set mcpAllowedExecutables in ForgeServerConfig.",
              },
            },
            403
          );
        }
        // SEC-H-02: reject inline-eval argument forms (`node -e …`, `bash -c …`,
        // `npx <pkg>`) under the strict policy. A patch may change only the
        // command or only the args, so validate the effective combination.
        const effectiveArgs =
          patch.args !== undefined ? patch.args : existing?.args;
        try {
          assertMcpCommandAllowed(
            effectiveEndpoint,
            effectiveArgs,
            config.mcpStdioArgPolicy ?? "strict"
          );
        } catch (err) {
          return forbiddenCommandResponse(c, err);
        }
      }
    }

    const effectiveHttpTransport = patch.transport ?? existing.transport;
    if (effectiveHttpTransport === "http" || effectiveHttpTransport === "sse") {
      const effectiveEndpoint = patch.endpoint ?? existing.endpoint;
      const urlPolicyError = await validateHttpServerInput(
        {
          transport: effectiveHttpTransport,
          endpoint: effectiveEndpoint,
        },
        config.mcpAllowedHttpHosts
      );
      if (urlPolicyError) return urlPolicyError;
    }

    try {
      const updated = await config.mcpManager!.updateServer(
        id,
        patch,
        tenantId
      );
      return c.json({ data: redactMcpDefinition(updated) });
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      if (internal.includes("not found")) {
        return c.json({ error: { code: "NOT_FOUND", message: safe } }, 404);
      }
      throw err;
    }
  });

  // DELETE /servers/:id — remove a server
  app.delete("/servers/:id", async (c) => {
    const id = c.req.param("id");
    const tenantId = getRequestingTenantId(c);
    try {
      // SEC-H-02: only the owning tenant may delete. `removeServer` is a no-op
      // for a resource the caller does not own, so a cross-tenant delete
      // resolves to the same 404 as a missing server.
      const existing = await config.mcpManager!.getServer(id, tenantId);
      if (!existing) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `MCP server "${id}" not found`,
            },
          },
          404
        );
      }
      await config.mcpManager!.removeServer(id, tenantId);
      return c.body(null, 204);
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      return c.json({ error: { code: "INTERNAL_ERROR", message: safe } }, 500);
    }
  });

  // POST /servers/:id/enable — enable a server
  app.post("/servers/:id/enable", async (c) => {
    const id = c.req.param("id");
    const tenantId = getRequestingTenantId(c);
    try {
      const server = await config.mcpManager!.enableServer(id, tenantId);
      return c.json({ data: redactMcpDefinition(server) });
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      if (internal.includes("not found")) {
        return c.json({ error: { code: "NOT_FOUND", message: safe } }, 404);
      }
      throw err;
    }
  });

  // POST /servers/:id/disable — disable a server
  app.post("/servers/:id/disable", async (c) => {
    const id = c.req.param("id");
    const tenantId = getRequestingTenantId(c);
    try {
      const server = await config.mcpManager!.disableServer(id, tenantId);
      return c.json({ data: redactMcpDefinition(server) });
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      if (internal.includes("not found")) {
        return c.json({ error: { code: "NOT_FOUND", message: safe } }, 404);
      }
      throw err;
    }
  });

  // POST /servers/:id/test — test connectivity
  app.post("/servers/:id/test", async (c) => {
    const id = c.req.param("id");
    const tenantId = getRequestingTenantId(c);
    try {
      const server = await config.mcpManager!.getServer(id, tenantId);
      if (!server) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `MCP server "${id}" not found`,
            },
          },
          404
        );
      }

      const urlPolicyError = await validateHttpServerInput(
        server,
        config.mcpAllowedHttpHosts
      );
      if (urlPolicyError) return urlPolicyError;

      const result = await config.mcpManager!.testServer(id, tenantId);
      return c.json({ data: result });
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      return c.json({ error: { code: "INTERNAL_ERROR", message: safe } }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // Profile routes
  // -------------------------------------------------------------------------

  // GET /profiles — list all profiles
  app.get("/profiles", async (c) => {
    const profiles = await config.mcpManager!.listProfiles(
      getRequestingTenantId(c)
    );
    return c.json({ data: profiles, count: profiles.length });
  });

  // POST /profiles — create a profile
  app.post("/profiles", async (c) => {
    const tenantId = getRequestingTenantId(c);
    let body: McpProfile;
    try {
      const raw = await c.req.json<McpProfile>();
      // SEC-H-02: strip any client-supplied tenantId; ownership is derived
      // from the authenticated caller.
      const { tenantId: _ignoredProfileTenant, ...rest } = raw;
      body = rest as McpProfile;
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } },
        400
      );
    }

    if (getSerializedJsonSizeBytes(body) > MCP_PROFILE_MAX_BYTES) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "profile too large (max 128 KB)",
          },
        },
        413
      );
    }

    if (!body.id || !Array.isArray(body.serverIds)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "id and serverIds (array) are required",
          },
        },
        400
      );
    }

    try {
      const profile = await config.mcpManager!.addProfile(body, tenantId);
      return c.json({ data: profile }, 201);
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      if (internal.includes("already exists")) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: safe } },
          409
        );
      }
      throw err;
    }
  });

  // GET /profiles/:id — get a profile
  app.get("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    const profile = await config.mcpManager!.getProfile(
      id,
      getRequestingTenantId(c)
    );
    if (!profile) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `MCP profile "${id}" not found`,
          },
        },
        404
      );
    }
    return c.json({ data: profile });
  });

  // DELETE /profiles/:id — remove a profile
  app.delete("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    const tenantId = getRequestingTenantId(c);
    try {
      // SEC-H-02: cross-tenant delete resolves to 404 (resource is invisible).
      const existing = await config.mcpManager!.getProfile(id, tenantId);
      if (!existing) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `MCP profile "${id}" not found`,
            },
          },
          404
        );
      }
      await config.mcpManager!.removeProfile(id, tenantId);
      return c.body(null, 204);
    } catch (err) {
      const { safe, internal } = sanitizeError(err);
      secureLogger.error(`[mcp] ${internal}`);
      return c.json({ error: { code: "INTERNAL_ERROR", message: safe } }, 500);
    }
  });
}
