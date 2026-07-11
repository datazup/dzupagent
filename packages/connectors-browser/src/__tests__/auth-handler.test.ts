import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "playwright";
import { AuthHandler } from "../browser/auth-handler.js";
import type { BrowserAuthCookie } from "../index.js";
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
        expect.objectContaining({ waitUntil: "networkidle" })
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
        vi.mocked(page.waitForSelector).mock.calls.length
      ).toBeGreaterThanOrEqual(2);
      // One of the calls should be for the password selector
      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        'input[type="password"]',
        expect.objectContaining({ state: "visible" })
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
        expect.objectContaining({ state: "visible" })
      );
      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        "#my-password",
        expect.objectContaining({ state: "visible" })
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
        {
          name: "session",
          value: "abc123",
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    });

    it("uses custom path when provided", async () => {
      const handler = new AuthHandler();
      const context = makeMockContext();

      await handler.loginWithCookies(context, [
        { name: "token", value: "xyz", domain: "example.com", path: "/api" },
      ]);

      expect(vi.mocked(context.addCookies)).toHaveBeenCalledWith([
        {
          name: "token",
          value: "xyz",
          domain: "example.com",
          path: "/api",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    });

    it("preserves explicit cookie security attributes and expiry", async () => {
      const handler = new AuthHandler();
      const context = makeMockContext();
      const cookie: BrowserAuthCookie = {
        name: "client-session",
        value: "xyz",
        domain: "example.com",
        path: "/app",
        secure: false,
        httpOnly: false,
        sameSite: "None",
        expires: 1_800_000_000,
      };

      await handler.loginWithCookies(context, [cookie]);

      expect(vi.mocked(context.addCookies)).toHaveBeenCalledWith([
        {
          name: "client-session",
          value: "xyz",
          domain: "example.com",
          path: "/app",
          secure: false,
          httpOnly: false,
          sameSite: "None",
          expires: 1_800_000_000,
        },
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
        'input[type="password"]'
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

    it("retries after a settle wait when the SPA client-side-redirects to the login route late", async () => {
      const { page } = makeMockPage();
      let passwordChecks = 0;
      const passwordLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        // First pass sees the app-shell skeleton (no form); the auth-check
        // redirect lands the login form by the second pass.
        count: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(passwordChecks++ === 0 ? 0 : 1)
          ),
      };
      const emptyLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(0),
      };
      vi.mocked(page.locator).mockImplementation((selector: unknown) => {
        if (selector === 'input[type="password"]')
          return passwordLocator as never;
        return emptyLocator as never;
      });
      const handler = new AuthHandler();

      const found = await handler.discoverLoginEntry(page);

      expect(found).toBe(true);
      expect(vi.mocked(page.waitForTimeout)).toHaveBeenCalled();
      expect(emptyLocator.click).not.toHaveBeenCalled();
    });

    it("enters an SSO-only login page via its SSO entry button when no form or sign-in link exists", async () => {
      const { page } = makeMockPage();
      const ssoLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(1),
      };
      const passwordLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        // no form before SSO entry (0), IdP shows a form after (1)
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
      };
      const emptyLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(0),
      };
      vi.mocked(page.locator).mockImplementation((selector: unknown) => {
        if (selector === 'input[type="password"]')
          return passwordLocator as never;
        if (selector === "button, a") return ssoLocator as never;
        return emptyLocator as never;
      });
      const handler = new AuthHandler();

      const found = await handler.discoverLoginEntry(page);

      expect(found).toBe(true);
      expect(ssoLocator.click).toHaveBeenCalled();
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
        }
      );

      expect(vi.mocked(page.goto)).toHaveBeenCalledWith(
        "https://app.example.com/login",
        expect.objectContaining({ waitUntil: "networkidle" })
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
        creds
      );

      expect(vi.mocked(page.goto)).toHaveBeenCalledWith(
        "https://app.example.com",
        expect.objectContaining({ waitUntil: "networkidle" })
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
        creds
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
        }
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
        }
      );
      // isLoginPage at declared loginUrl: form present (1), then post-submit
      // check on the interstitial: no password field (0) — repeats per attempt.
      locatorInstance.count.mockImplementation(() =>
        Promise.resolve(
          locatorInstance.count.mock.calls.length % 2 === 1 ? 1 : 0
        )
      );
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        {
          loginUrl: "https://app.example.com/login",
          maxAttempts: 1,
        }
      );

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("LOGIN_FAILED");
    });

    it("resolves an account/tenant-picker interstitial after credential submit and succeeds", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(1) // isLoginPage at declared loginUrl: form present
        .mockResolvedValueOnce(1) // isLoginPage after submit: password field still present (dzid keeps the form visible under the picker)
        .mockResolvedValueOnce(1) // picker radio options present
        .mockResolvedValueOnce(1) // explicit Continue-style button present
        .mockResolvedValueOnce(0); // isLoginPage after picker step: gone → success
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        { loginUrl: "https://auth.example.com/login" }
      );

      expect(result.success).toBe(true);
      expect(result.interstitialStepsTaken).toBe(1);
      // credential submit + radio option + continue button
      expect(
        vi.mocked(locatorInstance.click).mock.calls.length
      ).toBeGreaterThanOrEqual(3);
    });

    it("prefers the accountHint-matching option on an account picker", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(1) // isLoginPage: form present
        .mockResolvedValueOnce(1) // isLoginPage after submit: still present
        .mockResolvedValueOnce(1) // radio options present
        .mockResolvedValueOnce(1) // continue button present
        .mockResolvedValueOnce(1) // hinted radio exists
        .mockResolvedValueOnce(0); // isLoginPage after step: success
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        {
          loginUrl: "https://auth.example.com/login",
          accountHint: "tenant-mvp-local",
        }
      );

      expect(result.success).toBe(true);
      expect(vi.mocked(page.getByRole)).toHaveBeenCalledWith(
        "radio",
        expect.objectContaining({ name: "tenant-mvp-local" })
      );
    });

    it("consults the custom onInterstitial resolver before the built-in picker", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(1) // isLoginPage: form present
        .mockResolvedValueOnce(1) // isLoginPage after submit: still present
        .mockResolvedValueOnce(0); // isLoginPage after resolver acted: success
      const onInterstitial = vi.fn().mockResolvedValue("acted" as const);
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        { loginUrl: "https://auth.example.com/login", onInterstitial }
      );

      expect(result.success).toBe(true);
      expect(result.interstitialStepsTaken).toBe(1);
      expect(onInterstitial).toHaveBeenCalledWith(
        page,
        expect.objectContaining({ stepIndex: 0 })
      );
      // Built-in picker (getByRole lookups) never consulted
      expect(vi.mocked(page.getByRole)).not.toHaveBeenCalled();
    });

    it("still fails with LOGIN_FAILED on wrong credentials — no picker pattern, no interstitial action", async () => {
      const { page } = makeMockPage();
      const makeKeyedLocator = (count: number) => ({
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(count),
        textContent: vi.fn().mockResolvedValue(null),
      });
      const passwordLocator = makeKeyedLocator(1); // always still a login page
      const emptyLocator = makeKeyedLocator(0); // no radios, no SSO entry, no alert
      const genericLocator = makeKeyedLocator(1); // fill/submit interactions
      vi.mocked(page.locator).mockImplementation((selector: unknown) => {
        if (selector === 'input[type="password"]')
          return passwordLocator as never;
        if (
          typeof selector === "string" &&
          (selector.includes("radio") ||
            selector === "button, a" ||
            selector.includes("sso") ||
            selector.includes("alert"))
        )
          return emptyLocator as never;
        return genericLocator as never;
      });
      vi.mocked(page.getByRole).mockReturnValue(emptyLocator as never);
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        { loginUrl: "https://auth.example.com/login" }
      );

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("LOGIN_FAILED");
      expect(result.failureMessage).toMatch(/still on a login page/);
      expect(result.interstitialStepsTaken).toBe(0);
    });

    it("recovers from a bad declared loginUrl by following a discovered sign-in link", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count
        .mockResolvedValueOnce(0) // declared URL: no password field (404/error page)
        .mockResolvedValueOnce(1) // a sign-in link exists
        .mockResolvedValueOnce(1) // after click: login form present
        .mockResolvedValueOnce(0); // after submit: success
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        { loginUrl: "https://auth.example.com/login?mangled" }
      );

      expect(result.success).toBe(true);
    });

    it("mentions the declared Login URL in LOGIN_PAGE_NOT_FOUND when one was provided", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count.mockResolvedValue(0); // no form, no links anywhere
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        { loginUrl: "https://auth.example.com/login?mangled" }
      );

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("LOGIN_PAGE_NOT_FOUND");
      expect(result.failureMessage).toContain("declared Login URL");
    });

    it("includes the login page's visible alert text in the LOGIN_FAILED message", async () => {
      const { page, locatorInstance } = makeMockPage();
      locatorInstance.count.mockImplementation(() => {
        const n = locatorInstance.count.mock.calls.length;
        // per attempt: isLoginPage(1) → still login after submit(1) → no radios(0)
        // → SSO/alert lookups resolve via non-zero for alert
        return Promise.resolve(n % 3 === 0 ? 0 : 1);
      });
      locatorInstance.textContent.mockResolvedValue(
        "  Please verify your email before signing in.  "
      );
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds,
        { loginUrl: "https://auth.example.com/login", maxAttempts: 1 }
      );

      expect(result.success).toBe(false);
      expect(result.failureMessage).toContain(
        'The login page reported: "Please verify your email before signing in."'
      );
    });

    it("pivots to the SSO entry when the local form rejects the credentials, then succeeds at the IdP", async () => {
      const { page } = makeMockPage();
      // Local form rejects: URL never changes, no post-login indicator.
      vi.mocked(page.waitForURL).mockRejectedValue(new Error("timeout"));
      vi.mocked(page.waitForSelector).mockImplementation((selector: unknown) =>
        typeof selector === "string" && selector.includes("nav")
          ? Promise.reject(new Error("timeout"))
          : Promise.resolve(undefined as never)
      );
      let passwordChecks = 0;
      const passwordLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        // login page (1), pre-pivot check (1), IdP page is a login page (1),
        // post-IdP-submit gone (0). The post-local-submit check is skipped —
        // no positive signal short-circuits the success condition.
        count: vi.fn().mockImplementation(() => {
          passwordChecks++;
          return Promise.resolve(passwordChecks >= 4 ? 0 : 1);
        }),
      };
      const ssoLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockImplementation(() => {
          // After entering SSO the IdP redirect "changes" the URL and the
          // post-IdP-submit wait resolves via URL change.
          vi.mocked(page.waitForURL).mockResolvedValue(undefined as never);
          return Promise.resolve(undefined);
        }),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(1),
      };
      const genericLocator = {
        first: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(0),
      };
      vi.mocked(page.locator).mockImplementation((selector: unknown) => {
        if (selector === 'input[type="password"]')
          return passwordLocator as never;
        if (selector === "button, a") return ssoLocator as never;
        // username/submit locators during fill need fill/click to work
        if (
          typeof selector === "string" &&
          (selector.includes("email") || selector.includes("submit"))
        )
          return genericLocator as never;
        return genericLocator as never;
      });
      vi.mocked(page.getByRole).mockReturnValue(genericLocator as never);
      const handler = new AuthHandler();

      const result = await handler.performLogin(
        page,
        "https://app.example.com",
        creds
      );

      expect(result.success).toBe(true);
      expect(ssoLocator.click).toHaveBeenCalledTimes(1);
      // one goto only — the pivot happens within the first attempt
      expect(vi.mocked(page.goto)).toHaveBeenCalledTimes(1);
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
        creds
      );

      expect(result.success).toBe(true);
      expect(result.traversedOrigins).toContain(
        "https://auth.sso-provider.test"
      );
      expect(result.finalUrl).toBe("https://app.example.com/dashboard");
    });
  });
});
