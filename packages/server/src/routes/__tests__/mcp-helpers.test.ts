import { afterEach, describe, expect, it, vi } from "vitest";
import { secureLogger } from "@dzupagent/core/utils";
import { validateMcpHttpEndpoint } from "../../security/mcp-url-policy.js";
import { validateHttpServerInput } from "../mcp-helpers.js";

vi.mock("../../security/mcp-url-policy.js", () => ({
  validateMcpHttpEndpoint: vi.fn(),
}));

describe("validateHttpServerInput", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "resolved private address",
      'URL host "internal.example" resolved to non-public IP address "10.0.0.7".',
      "10.0.0.7",
    ],
    [
      "DNS error",
      'URL host "missing.example" could not be resolved: getaddrinfo ENOTFOUND missing.example',
      "getaddrinfo ENOTFOUND",
    ],
  ])("returns an opaque 403 and logs the %s once", async (_case, reason, leakedText) => {
    vi.mocked(validateMcpHttpEndpoint).mockResolvedValueOnce({
      ok: false,
      reason,
    });
    const errorSpy = vi.spyOn(secureLogger, "error").mockImplementation(() => {});

    const response = await validateHttpServerInput(
      { transport: "http", endpoint: "https://internal.example/mcp" },
      undefined
    );

    expect(response?.status).toBe(403);
    const body = await response!.text();
    expect(body).toContain("MCP endpoint rejected by URL policy.");
    expect(body).not.toContain(leakedText);
    expect(body).not.toContain(reason);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith({
      event: "mcp_url_policy_rejection",
      transport: "http",
      endpoint: "https://internal.example/mcp",
      reason,
    });
  });
});
