import { describe, expect, it, vi } from "vitest";
import type { Page, Request, Route } from "playwright";
import {
  assertBrowserNavigationAllowed,
  installBrowserNavigationPolicy,
  validateBrowserNavigationUrl,
} from "../browser/navigation-policy.js";
import type { NavigationResolvedAddress } from "../types.js";

describe("validateBrowserNavigationUrl", () => {
  it.each([
    ["loopback", "http://127.0.0.1/admin"],
    ["private IPv4", "http://192.168.1.10/admin"],
    ["link-local", "http://169.254.10.20/latest"],
    ["AWS metadata IP", "http://169.254.169.254/latest/meta-data/"],
    ["CGNAT", "http://100.64.0.5/admin"],
    ["metadata hostname", "http://metadata.google.internal/computeMetadata/v1"],
    ["localhost", "http://localhost:3000"],
    ["IPv6 loopback", "http://[::1]:8080/admin"],
  ])("blocks %s navigation by default", (_label, url) => {
    expect(() => validateBrowserNavigationUrl(url)).toThrow(
      "private or local network host"
    );
  });

  it("blocks disallowed protocols by default", () => {
    expect(() => validateBrowserNavigationUrl("file:///etc/passwd")).toThrow(
      "disallowed protocol"
    );
  });

  it("allows private-network navigation only with explicit opt-in", () => {
    expect(() =>
      validateBrowserNavigationUrl("http://127.0.0.1/admin", {
        allowPrivateNetwork: true,
      })
    ).not.toThrow();
  });

  it("allows public http and https URLs by default", () => {
    expect(validateBrowserNavigationUrl("https://example.com/path").href).toBe(
      "https://example.com/path"
    );
    expect(validateBrowserNavigationUrl("http://example.com/path").href).toBe(
      "http://example.com/path"
    );
  });
});

// A deterministic DNS lookup factory for tests: maps hostname -> addresses.
function fakeLookup(
  map: Record<string, NavigationResolvedAddress[]>
): (hostname: string) => Promise<ReadonlyArray<NavigationResolvedAddress>> {
  return async (hostname: string) => {
    const entry = map[hostname.toLowerCase()];
    if (!entry) {
      throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    }
    return entry;
  };
}

describe("assertBrowserNavigationAllowed (DNS-resolved IP check)", () => {
  it("blocks a literal private IP without performing DNS", async () => {
    const lookup = vi.fn(fakeLookup({}));
    await expect(
      assertBrowserNavigationAllowed("http://10.0.0.5/admin", { lookup })
    ).rejects.toThrow("private or local network host");
    // Literal IPs must not trigger a DNS lookup.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("blocks a public hostname that DNS-resolves to a private IP (DNS rebinding)", async () => {
    const lookup = fakeLookup({
      "internal.example": [{ address: "10.1.2.3", family: 4 }],
    });
    await expect(
      assertBrowserNavigationAllowed("http://internal.example/admin", {
        lookup,
      })
    ).rejects.toThrow("private or local network host");
  });

  it("blocks when ANY of multiple resolved addresses is private (rebind defense)", async () => {
    const lookup = fakeLookup({
      "rebind.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    await expect(
      assertBrowserNavigationAllowed("http://rebind.example/x", { lookup })
    ).rejects.toThrow("private or local network host");
  });

  it("blocks a hostname that resolves to an IPv4-mapped IPv6 private address", async () => {
    const lookup = fakeLookup({
      "mapped.example": [{ address: "::ffff:10.0.0.7", family: 6 }],
    });
    await expect(
      assertBrowserNavigationAllowed("http://mapped.example/x", { lookup })
    ).rejects.toThrow("private or local network host");
  });

  it("allows a public hostname that resolves only to public IPs", async () => {
    const lookup = fakeLookup({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    });
    const result = await assertBrowserNavigationAllowed(
      "https://public.example/path",
      {
        lookup,
      }
    );
    expect(result.href).toBe("https://public.example/path");
  });

  it("blocks a hostname that fails to resolve", async () => {
    const lookup = fakeLookup({});
    await expect(
      assertBrowserNavigationAllowed("https://does-not-resolve.example/x", {
        lookup,
      })
    ).rejects.toThrow("could not be resolved");
  });

  it("skips DNS resolution when resolveDns is false", async () => {
    const lookup = vi.fn(fakeLookup({}));
    await expect(
      assertBrowserNavigationAllowed("https://public.example/path", {
        resolveDns: false,
        lookup,
      })
    ).resolves.toBeInstanceOf(URL);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("skips DNS resolution when private networks are explicitly allowed", async () => {
    const lookup = vi.fn(fakeLookup({}));
    await assertBrowserNavigationAllowed("http://internal.example/admin", {
      allowPrivateNetwork: true,
      lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Subresource + redirect interception via installBrowserNavigationPolicy
// ---------------------------------------------------------------------------

interface RouteCall {
  url: string;
  resourceType: string;
  isNavigation: boolean;
}

/**
 * Drives a single request through the route handler registered by
 * installBrowserNavigationPolicy and reports whether it was aborted.
 */
async function runRouteHandler(
  handler: (route: Route) => Promise<void>,
  call: RouteCall
): Promise<{ aborted: boolean; abortReason?: string }> {
  let aborted = false;
  let abortReason: string | undefined;
  let continued = false;

  const request = {
    url: () => call.url,
    resourceType: () => call.resourceType,
    isNavigationRequest: () => call.isNavigation,
  } as unknown as Request;

  const route = {
    request: () => request,
    abort: vi.fn(async (reason?: string) => {
      aborted = true;
      abortReason = reason;
    }),
    continue: vi.fn(async () => {
      continued = true;
    }),
  } as unknown as Route;

  await handler(route);
  void continued;
  return { aborted, abortReason };
}

function makeRoutablePage(): {
  page: Page;
  getHandler: () => (route: Route) => Promise<void>;
} {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const page = {
    route: vi.fn(
      async (_pattern: string, h: (route: Route) => Promise<void>) => {
        handler = h;
      }
    ),
  } as unknown as Page;

  return {
    page,
    getHandler: () => {
      if (!handler) throw new Error("route handler was not registered");
      return handler;
    },
  };
}

describe("installBrowserNavigationPolicy (subresource + redirect interception)", () => {
  it("blocks a subresource request to a private IP", async () => {
    const { page, getHandler } = makeRoutablePage();
    await installBrowserNavigationPolicy(page, {
      lookup: fakeLookup({}),
    });

    const result = await runRouteHandler(getHandler(), {
      url: "http://10.0.0.9/internal.js",
      resourceType: "script",
      isNavigation: false,
    });
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("blockedbyclient");
  });

  it("blocks a subresource whose hostname DNS-resolves to a private IP", async () => {
    const { page, getHandler } = makeRoutablePage();
    await installBrowserNavigationPolicy(page, {
      lookup: fakeLookup({
        "cdn.internal.example": [{ address: "192.168.0.5", family: 4 }],
      }),
    });

    const result = await runRouteHandler(getHandler(), {
      url: "http://cdn.internal.example/app.js",
      resourceType: "script",
      isNavigation: false,
    });
    expect(result.aborted).toBe(true);
  });

  it("blocks a redirect target that resolves to a private IP", async () => {
    // Playwright re-invokes the route handler for each redirect hop, so a
    // redirected request URL pointing at a private target is intercepted here.
    const { page, getHandler } = makeRoutablePage();
    await installBrowserNavigationPolicy(page, {
      lookup: fakeLookup({
        "evil-redirect.example": [{ address: "127.0.0.1", family: 4 }],
      }),
    });

    const result = await runRouteHandler(getHandler(), {
      url: "http://evil-redirect.example/landing",
      resourceType: "document",
      isNavigation: true,
    });
    expect(result.aborted).toBe(true);
  });

  it("allows a public subresource (no false positives)", async () => {
    const { page, getHandler } = makeRoutablePage();
    await installBrowserNavigationPolicy(page, {
      lookup: fakeLookup({
        "cdn.public.example": [{ address: "93.184.216.34", family: 4 }],
      }),
    });

    const result = await runRouteHandler(getHandler(), {
      url: "https://cdn.public.example/app.js",
      resourceType: "script",
      isNavigation: false,
    });
    expect(result.aborted).toBe(false);
  });
});
