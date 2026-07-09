import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "playwright";
import { AuthHandler } from "../browser/auth-handler.js";
import { makeMockPage, makeMockContext } from "./test-utils.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AuthHandler", () => {
  describe("loginWithCredentials", () => {
    it("navigates to loginUrl when provided", async () => {
      const { page } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        loginUrl: "https://example.com/auth",
        username: "user",
        password: "pass",
      });

      expect(vi.mocked(page.goto)).toHaveBeenCalledWith(
        "https://example.com/auth",
        expect.objectContaining({ waitUntil: "networkidle" }),
      );
    });

    it("does not navigate when loginUrl is not provided", async () => {
      const { page } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        username: "user",
        password: "pass",
      });

      expect(vi.mocked(page.goto)).not.toHaveBeenCalled();
    });

    it("waits for SPA hydration before interacting", async () => {
      const { page } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        username: "user",
        password: "pass",
      });

      expect(vi.mocked(page.waitForFunction)).toHaveBeenCalled();
    });

    it("waits for username and password selectors to be visible", async () => {
      const { page } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        username: "user",
        password: "pass",
      });

      // waitForSelector is called for username and password fields (at least 2 times)
      expect(
        vi.mocked(page.waitForSelector).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      // One of the calls should be for the password selector
      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        'input[type="password"]',
        expect.objectContaining({ state: "visible" }),
      );
    });

    it("uses custom selectors when provided", async () => {
      const { page } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        username: "user",
        password: "pass",
        usernameSelector: "#my-email",
        passwordSelector: "#my-password",
      });

      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        "#my-email",
        expect.objectContaining({ state: "visible" }),
      );
      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        "#my-password",
        expect.objectContaining({ state: "visible" }),
      );
    });

    it("fills username and password fields", async () => {
      const { page, locatorInstance } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        username: "testuser",
        password: "testpass",
      });

      // fill is called: clear username, fill username, clear password, fill password
      const fillCalls = vi
        .mocked(locatorInstance.fill)
        .mock.calls.map((call: unknown[]) => call[0]);
      expect(fillCalls).toContain("testuser");
      expect(fillCalls).toContain("testpass");
    });

    it("clicks the submit button", async () => {
      const { page, locatorInstance } = makeMockPage();
      const handler = new AuthHandler();

      await handler.loginWithCredentials(page, {
        username: "user",
        password: "pass",
      });

      // locator is called for username, password, and submit button
      expect(vi.mocked(locatorInstance.first)).toHaveBeenCalled();
      expect(vi.mocked(locatorInstance.click)).toHaveBeenCalled();
    });
  });

  describe("loginWithCookies", () => {
    it("adds cookies to the browser context", async () => {
      const handler = new AuthHandler();
      const context = makeMockContext();

      await handler.loginWithCookies(context, [
        { name: "session", value: "abc123", domain: "example.com" },
      ]);

      expect(vi.mocked(context.addCookies)).toHaveBeenCalledWith([
        { name: "session", value: "abc123", domain: "example.com", path: "/" },
      ]);
    });

    it("uses custom path when provided", async () => {
      const handler = new AuthHandler();
      const context = makeMockContext();

      await handler.loginWithCookies(context, [
        { name: "token", value: "xyz", domain: "example.com", path: "/api" },
      ]);

      expect(vi.mocked(context.addCookies)).toHaveBeenCalledWith([
        { name: "token", value: "xyz", domain: "example.com", path: "/api" },
      ]);
    });

    it("handles multiple cookies", async () => {
      const handler = new AuthHandler();
      const context = makeMockContext();

      await handler.loginWithCookies(context, [
        { name: "a", value: "1", domain: "example.com" },
        { name: "b", value: "2", domain: "example.com" },
      ]);

      const cookies = vi.mocked(context.addCookies).mock
        .calls[0]![0] as unknown[];
      expect(cookies).toHaveLength(2);
    });
  });

  describe("isLoginPage", () => {
    it("returns true when password fields exist", async () => {
      const { page } = makeMockPage({
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(1),
        }) as unknown as Page["locator"],
      });

      const handler = new AuthHandler();
      const result = await handler.isLoginPage(page);

      expect(result).toBe(true);
      expect(vi.mocked(page.locator)).toHaveBeenCalledWith(
        'input[type="password"]',
      );
    });

    it("returns false when no password fields exist", async () => {
      const { page } = makeMockPage({
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
        }) as unknown as Page["locator"],
      });

      const handler = new AuthHandler();
      const result = await handler.isLoginPage(page);

      expect(result).toBe(false);
    });
  });

  describe("discoverLoginEntry", () => {
    it("returns true without clicking when the page is already a login page", async () => {
      const { page, locatorInstance } = makeMockPage();
      // isLoginPage: password field count = 1
      locatorInstance.count.mockResolvedValueOnce(1);
      const handler = new AuthHandler();

      const found = await handler.discoverLoginEntry(page);

      expect(found).toBe(true);
      expect(vi.mocked(locatorInstance.click)).not.toHaveBeenCalled();
    });

    it("clicks a discovered login link and returns true when a login form appears", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(0) // isLoginPage: no password field on landing page
        .mockResolvedValueOnce(1) // candidate login link exists
        .mockResolvedValueOnce(1); // isLoginPage after click: password field present
      const handler = new AuthHandler();

      const found = await handler.discoverLoginEntry(page);

      expect(found).toBe(true);
      expect(vi.mocked(locatorInstance.click)).toHaveBeenCalled();
    });

    it("returns false when the page has no login form and no login link", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(0) // isLoginPage: no password field
        .mockResolvedValueOnce(0); // no candidate link
      const handler = new AuthHandler();

      const found = await handler.discoverLoginEntry(page);

      expect(found).toBe(false);
      expect(vi.mocked(locatorInstance.click)).not.toHaveBeenCalled();
    });

    it("clicks the higher-priority explicit login link even when a generic auth link appears earlier in DOM order", async () => {
      const { page } = makeMockPage();
      const explicitLoginLocator = {
        first: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(1),
      };
      const genericAuthLocator = {
        first: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(1),
      };
      const passwordFieldLocator = {
        first: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        // isLoginPage checks: no password field before click (0), present after (1)
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
      };
      vi.mocked(page.locator).mockImplementation((selector: unknown) => {
        if (selector === 'input[type="password"]')
          return passwordFieldLocator as never;
        // Both a broad marketing-style auth link and the explicit "Log in"
        // link exist on the page. The explicit selector has higher priority
        // in LOGIN_ENTRY_SELECTORS and MUST be preferred regardless of which
        // one this DOM happens to render first.
        if (selector === 'a:has-text("Log in")')
          return explicitLoginLocator as never;
        if (selector === 'a[href*="auth" i]')
          return genericAuthLocator as never;
        return { count: vi.fn().mockResolvedValue(0) } as never;
      });
      const handler = new AuthHandler();

      const found = await handler.discoverLoginEntry(page);

      expect(found).toBe(true);
      expect(explicitLoginLocator.click).toHaveBeenCalled();
      expect(genericAuthLocator.click).not.toHaveBeenCalled();
    });
  });

  describe("performLogin", () => {
    const creds = { username: "user", password: "pass" };

    it("uses the declared loginUrl and succeeds when the login form disappears after submit", async () => {
      const { page, locatorInstance } = makeMockPage();
      vi.mocked(page.url).mockReturnValue("https://app.example.com/dashboard");
      locatorInstance.count
        .mockResolvedValueOnce(1) // isLoginPage at declared loginUrl: form present
        .mockResolvedValueOnce(0); // isLoginPage after submit: form gone → success
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        {
          loginUrl: "https://app.example.com/login",
        },
      );

      expect(vi.mocked(page.goto)).toHaveBeenCalledWith(
        "https://app.example.com/login",
        expect.objectContaining({ waitUntil: "networkidle" }),
      );
      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe("https://app.example.com/dashboard");
    });

    it("discovers the login page from startUrl when no loginUrl is declared", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(1) // discoverLoginEntry → isLoginPage: already a login wall (SSO bounce)
        .mockResolvedValueOnce(0); // isLoginPage after submit: success
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
      );

      expect(vi.mocked(page.goto)).toHaveBeenCalledWith(
        "https://app.example.com",
        expect.objectContaining({ waitUntil: "networkidle" }),
      );
      expect(result.success).toBe(true);
    });

    it("fails with LOGIN_PAGE_NOT_FOUND when no login form or link exists", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(0) // isLoginPage: no
        .mockResolvedValueOnce(0); // no candidate link
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
      );

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("LOGIN_PAGE_NOT_FOUND");
      expect(result.failureMessage).toMatch(/^Scanner login page not found/);
    });

    it("retries once then fails with LOGIN_FAILED when the login form persists after submit", async () => {
      const { page, locatorInstance } = makeMockPage();
      // Attempt 1: login page found (1), still login page after submit (1)
      // Attempt 2: login page found (1), still login page after submit (1)
      locatorInstance.count.mockResolvedValue(1);
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        {
          loginUrl: "https://app.example.com/login",
        },
      );

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("LOGIN_FAILED");
      expect(result.failureMessage).toMatch(/^Scanner login failed/);
      // exactly 2 attempts — one goto per attempt, never more
      expect(vi.mocked(page.goto)).toHaveBeenCalledTimes(2);
    });

    it("fails with LOGIN_FAILED when a post-submit interstitial has no password field but never signals success (URL unchanged, no post-login indicator)", async () => {
      const { page, locatorInstance } = makeMockPage();
      // Page never changes URL after submit, and no post-login indicator ever appears —
      // waitForURL/waitForSelector in waitForLoginComplete must both time out.
      vi.mocked(page.waitForURL).mockRejectedValue(new Error("timeout"));
      vi.mocked(page.waitForSelector).mockImplementation(
        (selector: unknown, opts?: { timeout?: number }) => {
          // username/password selectors during fill must resolve; only the
          // post-login indicator wait (called with no explicit login field name)
          // should reject to simulate no post-login DOM indicator appearing.
          if (typeof selector === "string" && selector.includes("nav")) {
            return Promise.reject(new Error("timeout"));
          }
          return Promise.resolve(undefined);
        },
      );
      // isLoginPage at declared loginUrl: form present (1), then post-submit
      // check on the interstitial: no password field (0) — repeats per attempt.
      locatorInstance.count.mockImplementation(() =>
        Promise.resolve(
          locatorInstance.count.mock.calls.length % 2 === 1 ? 1 : 0,
        ),
      );
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        {
          loginUrl: "https://app.example.com/login",
          maxAttempts: 1,
        },
      );

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("LOGIN_FAILED");
    });

    it("records traversed origins for audit without exposing them as crawlable", async () => {
      const { page, locatorInstance } = makeMockPage();
      // Simulate SSO: landing check happens on the IdP, final lands back on the app
      vi.mocked(page.url)
        .mockReturnValueOnce("https://auth.sso-provider.test/authorize") // after initial goto
        .mockReturnValue("https://app.example.com/dashboard"); // thereafter
      locatorInstance.count
        .mockResolvedValueOnce(1) // isLoginPage on IdP: yes
        .mockResolvedValueOnce(0); // after submit: success
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
      );

      expect(result.success).toBe(true);
      expect(result.traversedOrigins).toContain(
        "https://auth.sso-provider.test",
      );
      expect(result.finalUrl).toBe("https://app.example.com/dashboard");
    });
  });
});
