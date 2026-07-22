import type { BrowserContext } from "playwright";
import type { BrowserAuthCookie } from "../../types.js";

/**
 * Cookie-based authentication strategy: seed a browser context with
 * pre-obtained session cookies. Extracted from the former monolithic
 * auth-handler.ts (ARCH-M-06 decomposition).
 */

/**
 * Set cookies on a browser context for authenticated access.
 */
export async function loginWithCookies(
  context: BrowserContext,
  cookies: BrowserAuthCookie[]
): Promise<void> {
  await context.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? true,
      sameSite: c.sameSite ?? "Lax",
      ...(c.expires !== undefined ? { expires: c.expires } : {}),
    }))
  );
}
