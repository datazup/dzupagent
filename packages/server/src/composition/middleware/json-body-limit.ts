/**
 * JSON body-size-guard middleware slice of the Hono app composition. Extracted
 * from the legacy `composition/middleware.ts` god-module (DZUPAGENT-ARCH-M-06).
 * Behaviour is unchanged, including the SEC-M-04 streaming size check.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { ForgeServerConfig, JsonBodyLimitConfig } from "../types.js";

export const DEFAULT_JSON_BODY_MAX_BYTES = 1_048_576;

const DEFAULT_ROUTE_JSON_BODY_MAX_BYTES: Record<string, number> = {
  "/api/memory/import": 8 * 1_048_576,
  "/api/workflows/compile": 2 * 1_048_576,
  "/v1/chat/completions": 2 * 1_048_576,
};

export function applyJsonBodySizeLimit(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (config.jsonBodyLimit === false) {
    return;
  }

  const limits = resolveJsonBodyLimits(config.jsonBodyLimit);
  app.use("*", async (c, next) => {
    if (!shouldCheckJsonBodySize(c.req.method, c.req.header("content-type"))) {
      return next();
    }

    const maxBytes = resolveJsonBodyMaxBytes(c.req.path, limits);
    const contentLength = parseContentLength(c.req.header("content-length"));
    if (contentLength !== undefined && contentLength > maxBytes) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `JSON request body too large (max ${maxBytes} bytes)`,
          },
        },
        413
      );
    }

    if (contentLength === undefined) {
      // SEC-M-04: stream the body and abort as soon as we have read more than
      // `maxBytes` (i.e. at `maxBytes + 1`). An oversize attacker payload is
      // never buffered in full — we stop reading the moment the limit is
      // crossed. For within-limit bodies we collect the (bounded) chunks and
      // rebuild the request so downstream handlers can still parse it.
      const result = await measureAndRebuildBody(c.req.raw, maxBytes);
      if (result.exceeded) {
        return c.json(
          {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: `JSON request body too large (max ${maxBytes} bytes)`,
            },
          },
          413
        );
      }
      if (result.rebuilt) {
        // Replace the consumed body with a fresh, replayable Request.
        c.req.raw = result.rebuilt;
      }
    }

    return next();
  });
}

interface ResolvedJsonBodyLimits {
  defaultMaxBytes: number;
  routeMaxBytes: Record<string, number>;
}

function resolveJsonBodyLimits(
  config?: JsonBodyLimitConfig
): ResolvedJsonBodyLimits {
  return {
    defaultMaxBytes: positiveIntegerOr(
      config?.defaultMaxBytes,
      DEFAULT_JSON_BODY_MAX_BYTES
    ),
    routeMaxBytes: {
      ...DEFAULT_ROUTE_JSON_BODY_MAX_BYTES,
      ...sanitizeRouteMaxBytes(config?.routeMaxBytes),
    },
  };
}

function sanitizeRouteMaxBytes(
  routeMaxBytes?: Record<string, number>
): Record<string, number> {
  if (!routeMaxBytes) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(routeMaxBytes).filter(
      ([path, bytes]) => path.length > 0 && Number.isInteger(bytes) && bytes > 0
    )
  );
}

function positiveIntegerOr(
  value: number | undefined,
  fallback: number
): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function shouldCheckJsonBodySize(
  method: string,
  contentType: string | undefined
): boolean {
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
    return false;
  }
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/json") || normalized.includes("+json")
  );
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface BodyMeasureResult {
  /** True when the body exceeded `maxBytes` (read aborted at `maxBytes + 1`). */
  exceeded: boolean;
  /**
   * A replayable Request rebuilt from the (within-limit) collected body, or
   * `undefined` when no rebuild is needed (no body, or the size check could not
   * run). The original body stream is consumed by the measurement, so callers
   * must swap to this rebuilt Request for downstream parsing.
   */
  rebuilt?: Request;
}

/**
 * SEC-M-04: stream the request body and abort the moment the cumulative byte
 * count exceeds `maxBytes` (i.e. at `maxBytes + 1`). An oversize payload is
 * never buffered in full — reading stops as soon as the limit is crossed, so an
 * attacker cannot force the process to allocate the whole body just to have its
 * size checked.
 *
 * Reading the body consumes the underlying stream, so for within-limit bodies we
 * collect the (bounded ≤ `maxBytes`) chunks and rebuild a fresh, replayable
 * Request that downstream handlers can parse.
 *
 * Returns `{ exceeded: false }` with no rebuild when the body cannot be streamed
 * (no body, or the runtime does not expose a readable stream), matching the
 * prior best-effort behaviour where an unreadable body was treated as size 0.
 */
async function measureAndRebuildBody(
  request: Request,
  maxBytes: number
): Promise<BodyMeasureResult> {
  const stream = request.body;
  if (!stream) {
    return { exceeded: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Abort: the remaining chunks are never read or buffered.
          return { exceeded: true };
        }
        chunks.push(value);
      }
    }
  } catch {
    // Treat an unreadable/aborted body as within-limit; the downstream JSON
    // parser will surface any genuine malformed-body error. Rebuild from what
    // we managed to collect so the downstream consumer still has a body.
    /* fall through to rebuild */
  } finally {
    reader.releaseLock();
  }

  // Reassemble the collected (bounded) chunks into a single buffer and rebuild a
  // replayable Request, since reading consumed the original stream.
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const rebuilt = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: total > 0 ? buffer : undefined,
    // Required by undici when a body stream/buffer is supplied.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return { exceeded: false, rebuilt };
}

function resolveJsonBodyMaxBytes(
  path: string,
  limits: ResolvedJsonBodyLimits
): number {
  const exact = limits.routeMaxBytes[path];
  if (exact !== undefined) {
    return exact;
  }

  let matchedBytes: number | undefined;
  let matchedPrefixLength = -1;
  for (const [pattern, bytes] of Object.entries(limits.routeMaxBytes)) {
    if (!pattern.endsWith("*")) {
      continue;
    }
    const prefix = pattern.slice(0, -1);
    if (path.startsWith(prefix) && prefix.length > matchedPrefixLength) {
      matchedBytes = bytes;
      matchedPrefixLength = prefix.length;
    }
  }

  return matchedBytes ?? limits.defaultMaxBytes;
}
