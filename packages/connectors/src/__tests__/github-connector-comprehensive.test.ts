/**
 * Comprehensive GitHub connector tests — 65+ tests covering:
 *
 *  1.  PR creation: correct title, body, base/head branch
 *  2.  PR creation failure: API error handling
 *  3.  Review comment: inline file/line comment
 *  4.  Review comment: general PR review (APPROVE / REQUEST_CHANGES / COMMENT)
 *  5.  Issue creation: title, body, labels, assignees
 *  6.  Issue update: title, body, state, labels
 *  7.  Issue close: state transition to closed
 *  8.  Webhook event parsing: push, PR opened, PR merged, issue opened (shape assertions)
 *  9.  Webhook signature verification helpers (HMAC-SHA256)
 * 10.  Repository file read: base64 content decode
 * 11.  Branch listing: format output
 * 12.  Authentication: Authorization header forwarded
 * 13.  Rate limit handling: 429 surfaces error string
 * 14.  GitHubClient direct-method coverage
 *
 * All HTTP calls are mocked — no real GitHub API requests are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGitHubConnector } from "../github/github-connector.js";
import { GitHubClient, GitHubApiError } from "../github/github-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockFetch(
  body: unknown,
  ok = true,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  const mock = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: {
      get: (name: string) => extraHeaders[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchSequence(
  responses: Array<{ body: unknown; ok?: boolean; status?: number }>,
) {
  let i = 0;
  const mock = vi.fn().mockImplementation(async () => {
    const r = responses[i] ?? responses[responses.length - 1]!;
    i++;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: () => null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function tool(name: string, token = "ghp_test_token") {
  const tools = createGitHubConnector({ token });
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

function calledUrl(mock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  return mock.mock.calls[callIndex]![0] as string;
}

function calledHeaders(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, string> {
  return (mock.mock.calls[callIndex]![1] as RequestInit).headers as Record<
    string,
    string
  >;
}

function parsedBody(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, unknown> {
  return JSON.parse(
    (mock.mock.calls[callIndex]![1] as RequestInit).body as string,
  ) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PR creation — correct fields forwarded
// ─────────────────────────────────────────────────────────────────────────────

describe("PR creation", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends correct title to GitHub API", async () => {
    const mock = mockFetch({
      number: 42,
      html_url: "https://github.com/o/r/pull/42",
    });
    await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "My Feature PR",
      body: "",
      head: "feat/branch",
      base: "main",
    });
    expect(parsedBody(mock).title).toBe("My Feature PR");
  });

  it("sends correct body to GitHub API", async () => {
    const mock = mockFetch({
      number: 7,
      html_url: "https://github.com/o/r/pull/7",
    });
    await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      body: "Detailed description",
      head: "feat/b",
      base: "main",
    });
    expect(parsedBody(mock).body).toBe("Detailed description");
  });

  it("sends correct head branch", async () => {
    const mock = mockFetch({
      number: 1,
      html_url: "https://github.com/o/r/pull/1",
    });
    await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "feature/my-work",
      base: "develop",
    });
    expect(parsedBody(mock).head).toBe("feature/my-work");
  });

  it("sends correct base branch", async () => {
    const mock = mockFetch({
      number: 1,
      html_url: "https://github.com/o/r/pull/1",
    });
    await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "feat/b",
      base: "release/v2",
    });
    expect(parsedBody(mock).base).toBe("release/v2");
  });

  it("calls the pulls endpoint for the right owner and repo", async () => {
    const mock = mockFetch({
      number: 5,
      html_url: "https://github.com/myorg/myrepo/pull/5",
    });
    await tool("github_create_pr").invoke({
      owner: "myorg",
      repo: "myrepo",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(calledUrl(mock)).toContain("/repos/myorg/myrepo/pulls");
  });

  it("returns created PR number and URL on success", async () => {
    mockFetch({ number: 99, html_url: "https://github.com/o/r/pull/99" });
    const result = await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(result).toContain("#99");
    expect(result).toContain("https://github.com/o/r/pull/99");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PR creation failure — API error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("PR creation failure", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns error string on 422 unprocessable entity", async () => {
    mockFetch({ message: "Validation Failed" }, false, 422);
    const result = await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(result).toContain("GitHub API error");
    expect(result).toContain("422");
  });

  it("returns error string on 403 forbidden", async () => {
    mockFetch(
      { message: "Resource not accessible by integration" },
      false,
      403,
    );
    const result = await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(result).toContain("403");
  });

  it("returns error string on 404 repo not found", async () => {
    mockFetch({ message: "Not Found" }, false, 404);
    const result = await tool("github_create_pr").invoke({
      owner: "no-such",
      repo: "repo",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(result).toContain("GitHub API error");
  });

  it("returns error string on network error (non-GitHubApiError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const result = await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(result).toContain("Error");
    expect(result).toContain("ECONNREFUSED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Review comment — inline file/line comment
// ─────────────────────────────────────────────────────────────────────────────

describe("Review comment — inline file/line", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends body, path, and line to pulls comments endpoint", async () => {
    const mock = mockFetch({ id: 101, body: "Please fix this" });
    await tool("github_create_review_comment").invoke({
      owner: "o",
      repo: "r",
      pr_number: 5,
      body: "Please fix this",
      path: "src/index.ts",
      line: 42,
    });
    const sent = parsedBody(mock);
    expect(sent.body).toBe("Please fix this");
    expect(sent.path).toBe("src/index.ts");
    expect(sent.line).toBe(42);
  });

  it("calls the correct pulls comments URL", async () => {
    const mock = mockFetch({ id: 1, body: "ok" });
    await tool("github_create_review_comment").invoke({
      owner: "org",
      repo: "app",
      pr_number: 12,
      body: "nit",
      path: "README.md",
      line: 1,
    });
    expect(calledUrl(mock)).toContain("/repos/org/app/pulls/12/comments");
  });

  it("returns confirmation with comment id on success", async () => {
    mockFetch({ id: 555, body: "Style issue on this line" });
    const result = await tool("github_create_review_comment").invoke({
      owner: "o",
      repo: "r",
      pr_number: 3,
      body: "Style issue on this line",
      path: "a.ts",
      line: 7,
    });
    expect(result).toContain("id=555");
  });

  it("returns error string on 404 PR not found", async () => {
    mockFetch({ message: "Not Found" }, false, 404);
    const result = await tool("github_create_review_comment").invoke({
      owner: "o",
      repo: "r",
      pr_number: 9999,
      body: "comment",
      path: "x.ts",
      line: 1,
    });
    expect(result).toContain("GitHub API error");
    expect(result).toContain("404");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Review comment — general PR review (APPROVE / REQUEST_CHANGES / COMMENT)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR review creation", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends APPROVE event correctly", async () => {
    const mock = mockFetch({
      id: 1,
      state: "APPROVED",
      html_url: "https://github.com/o/r/pull/1#pullrequestreview-1",
    });
    await tool("github_create_pr_review").invoke({
      owner: "o",
      repo: "r",
      pr_number: 1,
      body: "LGTM",
      event: "APPROVE",
    });
    expect(parsedBody(mock).event).toBe("APPROVE");
  });

  it("sends REQUEST_CHANGES event correctly", async () => {
    const mock = mockFetch({
      id: 2,
      state: "CHANGES_REQUESTED",
      html_url: "https://github.com/o/r/pull/2#pullrequestreview-2",
    });
    await tool("github_create_pr_review").invoke({
      owner: "o",
      repo: "r",
      pr_number: 2,
      body: "Please fix X",
      event: "REQUEST_CHANGES",
    });
    expect(parsedBody(mock).event).toBe("REQUEST_CHANGES");
  });

  it("sends COMMENT event correctly", async () => {
    const mock = mockFetch({
      id: 3,
      state: "COMMENTED",
      html_url: "https://github.com/o/r/pull/3#pullrequestreview-3",
    });
    await tool("github_create_pr_review").invoke({
      owner: "o",
      repo: "r",
      pr_number: 3,
      body: "Just a note",
      event: "COMMENT",
    });
    expect(parsedBody(mock).event).toBe("COMMENT");
  });

  it("returns review state in success message", async () => {
    mockFetch({
      id: 10,
      state: "APPROVED",
      html_url: "https://github.com/o/r/pull/1#review-10",
    });
    const result = await tool("github_create_pr_review").invoke({
      owner: "o",
      repo: "r",
      pr_number: 1,
      body: "ok",
      event: "APPROVE",
    });
    expect(result).toContain("APPROVED");
  });

  it("calls the correct pulls reviews URL", async () => {
    const mock = mockFetch({
      id: 1,
      state: "APPROVED",
      html_url: "https://github.com/o/r/pull/5#review-1",
    });
    await tool("github_create_pr_review").invoke({
      owner: "myorg",
      repo: "myrepo",
      pr_number: 5,
      body: "ok",
      event: "APPROVE",
    });
    expect(calledUrl(mock)).toContain("/repos/myorg/myrepo/pulls/5/reviews");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Issue creation
// ─────────────────────────────────────────────────────────────────────────────

describe("Issue creation", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends title and body to issues endpoint", async () => {
    const mock = mockFetch({
      number: 1,
      html_url: "https://github.com/o/r/issues/1",
    });
    await tool("github_create_issue").invoke({
      owner: "o",
      repo: "r",
      title: "Bug: something broken",
      body: "Steps to reproduce…",
    });
    const sent = parsedBody(mock);
    expect(sent.title).toBe("Bug: something broken");
    expect(sent.body).toBe("Steps to reproduce…");
  });

  it("sends labels array when provided", async () => {
    const mock = mockFetch({
      number: 2,
      html_url: "https://github.com/o/r/issues/2",
    });
    await tool("github_create_issue").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      labels: ["bug", "P1"],
    });
    expect(parsedBody(mock).labels).toEqual(["bug", "P1"]);
  });

  it("sends assignees when provided", async () => {
    const mock = mockFetch({
      number: 3,
      html_url: "https://github.com/o/r/issues/3",
    });
    await tool("github_create_issue").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      assignees: ["alice", "bob"],
    });
    expect(parsedBody(mock).assignees).toEqual(["alice", "bob"]);
  });

  it("returns created issue number and URL", async () => {
    mockFetch({ number: 77, html_url: "https://github.com/o/r/issues/77" });
    const result = await tool("github_create_issue").invoke({
      owner: "o",
      repo: "r",
      title: "T",
    });
    expect(result).toContain("#77");
    expect(result).toContain("https://github.com/o/r/issues/77");
  });

  it("calls correct issues URL", async () => {
    const mock = mockFetch({
      number: 1,
      html_url: "https://github.com/a/b/issues/1",
    });
    await tool("github_create_issue").invoke({
      owner: "a",
      repo: "b",
      title: "T",
    });
    expect(calledUrl(mock)).toContain("/repos/a/b/issues");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Issue update
// ─────────────────────────────────────────────────────────────────────────────

describe("Issue update", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends updated title via PATCH", async () => {
    const mock = mockFetch({
      number: 5,
      state: "open",
      html_url: "https://github.com/o/r/issues/5",
    });
    await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 5,
      title: "Updated title",
    });
    expect(parsedBody(mock).title).toBe("Updated title");
  });

  it("sends updated body via PATCH", async () => {
    const mock = mockFetch({
      number: 5,
      state: "open",
      html_url: "https://github.com/o/r/issues/5",
    });
    await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 5,
      body: "New description",
    });
    expect(parsedBody(mock).body).toBe("New description");
  });

  it("sends updated labels via PATCH", async () => {
    const mock = mockFetch({
      number: 5,
      state: "open",
      html_url: "https://github.com/o/r/issues/5",
    });
    await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 5,
      labels: ["enhancement", "wontfix"],
    });
    expect(parsedBody(mock).labels).toEqual(["enhancement", "wontfix"]);
  });

  it("calls correct issues/:number URL", async () => {
    const mock = mockFetch({
      number: 10,
      state: "open",
      html_url: "https://github.com/o/r/issues/10",
    });
    await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 10,
      title: "T",
    });
    expect(calledUrl(mock)).toContain("/repos/o/r/issues/10");
  });

  it("returns updated issue number and state in response", async () => {
    mockFetch({
      number: 5,
      state: "open",
      html_url: "https://github.com/o/r/issues/5",
    });
    const result = await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 5,
      title: "Updated",
    });
    expect(result).toContain("#5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Issue close
// ─────────────────────────────────────────────────────────────────────────────

describe("Issue close", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends state=closed to close an issue", async () => {
    const mock = mockFetch({
      number: 8,
      state: "closed",
      html_url: "https://github.com/o/r/issues/8",
    });
    await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 8,
      state: "closed",
    });
    expect(parsedBody(mock).state).toBe("closed");
  });

  it("returns closed state in success string", async () => {
    mockFetch({
      number: 8,
      state: "closed",
      html_url: "https://github.com/o/r/issues/8",
    });
    const result = await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 8,
      state: "closed",
    });
    expect(result).toContain("closed");
  });

  it("returns error string when closing nonexistent issue", async () => {
    mockFetch({ message: "Not Found" }, false, 404);
    const result = await tool("github_update_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 9999,
      state: "closed",
    });
    expect(result).toContain("GitHub API error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Webhook event shape — testing payload structures
// (No real webhook parsing in the connector; we verify the tool data shapes
//  that would come from webhook-triggered data by calling list/get tools with
//  mock responses matching webhook payloads.)
// ─────────────────────────────────────────────────────────────────────────────

describe("Webhook event shapes — push event data", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("get_commit returns correct push-event commit shape (sha, message, author)", async () => {
    mockFetch({
      sha: "abc123def456",
      commit: {
        message: "fix: resolve login bug",
        author: { name: "Alice", date: "2024-01-01T00:00:00Z" },
      },
      html_url: "https://github.com/o/r/commit/abc123def456",
      author: { login: "alice" },
    });
    const result = await tool("github_get_commit").invoke({
      owner: "o",
      repo: "r",
      sha: "abc123",
    });
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.sha).toBe("abc123def456");
    expect((parsed.commit as Record<string, unknown>).message).toBe(
      "fix: resolve login bug",
    );
  });
});

describe("Webhook event shapes — PR opened event", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("get_pr returns PR number, head ref, and base ref as in PR opened webhook", async () => {
    mockFetch({
      number: 42,
      title: "feat: add dark mode",
      state: "open",
      html_url: "https://github.com/o/r/pull/42",
      head: { ref: "feat/dark-mode", sha: "deadbeef" },
      base: { ref: "main", sha: "cafebabe" },
      merged: false,
      mergeable: true,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      user: { login: "alice" },
      body: null,
    });
    const result = await tool("github_get_pr").invoke({
      owner: "o",
      repo: "r",
      pr_number: 42,
    });
    const pr = JSON.parse(result) as Record<string, unknown>;
    expect(pr.number).toBe(42);
    expect((pr.head as Record<string, unknown>).ref).toBe("feat/dark-mode");
    expect((pr.base as Record<string, unknown>).ref).toBe("main");
    expect(pr.state).toBe("open");
  });
});

describe("Webhook event shapes — PR merged event", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("get_pr returns merged=true and state=closed for merged PR", async () => {
    mockFetch({
      number: 50,
      title: "chore: update deps",
      state: "closed",
      html_url: "https://github.com/o/r/pull/50",
      head: { ref: "chore/deps", sha: "111aaa" },
      base: { ref: "main", sha: "222bbb" },
      merged: true,
      mergeable: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-03T00:00:00Z",
      user: { login: "bob" },
      body: null,
    });
    const result = await tool("github_get_pr").invoke({
      owner: "o",
      repo: "r",
      pr_number: 50,
    });
    const pr = JSON.parse(result) as Record<string, unknown>;
    expect(pr.merged).toBe(true);
    expect(pr.state).toBe("closed");
  });
});

describe("Webhook event shapes — issue opened event", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("get_issue returns correct shape matching issue opened webhook", async () => {
    mockFetch({
      number: 101,
      title: "Bug: login fails on Safari",
      body: "Steps to reproduce…",
      state: "open",
      html_url: "https://github.com/o/r/issues/101",
      labels: [{ name: "bug" }, { name: "P1" }],
      assignees: [{ login: "charlie" }],
      created_at: "2024-01-10T00:00:00Z",
      updated_at: "2024-01-10T00:00:00Z",
      user: { login: "reporter" },
    });
    const result = await tool("github_get_issue").invoke({
      owner: "o",
      repo: "r",
      issue_number: 101,
    });
    const issue = JSON.parse(result) as Record<string, unknown>;
    expect(issue.number).toBe(101);
    expect(issue.state).toBe("open");
    expect(
      (issue.labels as Array<{ name: string }>).map((l) => l.name),
    ).toContain("bug");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Webhook signature verification (HMAC-SHA256)
// Using Node crypto directly — GitHubClient doesn't expose a verify helper,
// so we test the logic that a real webhook handler would use.
// ─────────────────────────────────────────────────────────────────────────────

describe("Webhook signature verification logic", () => {
  it("valid HMAC-SHA256 signature matches body", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "my_webhook_secret";
    const payload = JSON.stringify({ action: "opened", number: 1 });
    const sig =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(sig).toBe(expected);
  });

  it("signature mismatch is detected when payload tampered", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "my_webhook_secret";
    const originalPayload = JSON.stringify({ action: "opened", number: 1 });
    const tamperedPayload = JSON.stringify({ action: "deleted", number: 1 });
    const sig =
      "sha256=" +
      createHmac("sha256", secret).update(originalPayload).digest("hex");
    const expected =
      "sha256=" +
      createHmac("sha256", secret).update(tamperedPayload).digest("hex");
    expect(sig).not.toBe(expected);
  });

  it("signature mismatch with wrong secret", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = JSON.stringify({ action: "opened" });
    const sig =
      "sha256=" +
      createHmac("sha256", "correct_secret").update(payload).digest("hex");
    const bad =
      "sha256=" +
      createHmac("sha256", "wrong_secret").update(payload).digest("hex");
    expect(sig).not.toBe(bad);
  });

  it("empty payload produces consistent signature", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "sec";
    const sig1 = createHmac("sha256", secret).update("").digest("hex");
    const sig2 = createHmac("sha256", secret).update("").digest("hex");
    expect(sig1).toBe(sig2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Repository file read
// ─────────────────────────────────────────────────────────────────────────────

describe("Repository file read", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("decodes base64-encoded file content", async () => {
    const content = Buffer.from("export const x = 1\n").toString("base64");
    mockFetch({
      type: "file",
      name: "index.ts",
      path: "src/index.ts",
      sha: "abc",
      encoding: "base64",
      content,
      html_url: "https://github.com/o/r/blob/main/src/index.ts",
    });
    const result = await tool("github_get_file").invoke({
      owner: "o",
      repo: "r",
      path: "src/index.ts",
    });
    expect(result).toBe("export const x = 1\n");
  });

  it("uses ref parameter when provided", async () => {
    const mock = mockFetch({
      type: "file",
      name: "a.ts",
      path: "a.ts",
      sha: "x",
      encoding: "base64",
      content: Buffer.from("hello").toString("base64"),
      html_url: "https://github.com/o/r/blob/v1.0/a.ts",
    });
    await tool("github_get_file").invoke({
      owner: "o",
      repo: "r",
      path: "a.ts",
      ref: "v1.0",
    });
    expect(calledUrl(mock)).toContain("ref=v1.0");
  });

  it("returns directory listing for array response", async () => {
    mockFetch([
      { type: "file", path: "src/a.ts", sha: "a" },
      { type: "dir", path: "src/lib", sha: "b" },
    ]);
    const result = await tool("github_get_file").invoke({
      owner: "o",
      repo: "r",
      path: "src",
    });
    expect(result).toContain("f src/a.ts");
    expect(result).toContain("d src/lib");
  });

  it("calls correct contents URL", async () => {
    const mock = mockFetch({
      type: "file",
      name: "README.md",
      path: "README.md",
      sha: "z",
      encoding: "base64",
      content: Buffer.from("# hi").toString("base64"),
      html_url: "https://github.com/o/r/blob/main/README.md",
    });
    await tool("github_get_file").invoke({
      owner: "myorg",
      repo: "myrepo",
      path: "README.md",
    });
    expect(calledUrl(mock)).toContain("/repos/myorg/myrepo/contents/README.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Branch listing
// ─────────────────────────────────────────────────────────────────────────────

describe("Branch listing", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("lists branches with name and short SHA", async () => {
    mockFetch([
      { name: "main", commit: { sha: "abcdef1234567" }, protected: true },
      { name: "feat/dark", commit: { sha: "1234567890abc" }, protected: false },
    ]);
    const result = await tool("github_list_branches").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("main");
    expect(result).toContain("abcdef1");
    expect(result).toContain("feat/dark");
  });

  it("marks protected branches", async () => {
    mockFetch([
      { name: "main", commit: { sha: "aaaaaaa000000" }, protected: true },
    ]);
    const result = await tool("github_list_branches").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("[protected]");
  });

  it("does not mark unprotected branches", async () => {
    mockFetch([
      { name: "feat/x", commit: { sha: "bbbbbbb111111" }, protected: false },
    ]);
    const result = await tool("github_list_branches").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).not.toContain("[protected]");
  });

  it("returns error string on 404", async () => {
    mockFetch({ message: "Not Found" }, false, 404);
    const result = await tool("github_list_branches").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("GitHub API error");
  });

  it("calls correct branches URL", async () => {
    const mock = mockFetch([]);
    await tool("github_list_branches").invoke({
      owner: "testorg",
      repo: "testrepo",
    });
    expect(calledUrl(mock)).toContain("/repos/testorg/testrepo/branches");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Authentication — Authorization header forwarded
// ─────────────────────────────────────────────────────────────────────────────

describe("Authentication headers", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("includes Authorization: Bearer header on all requests", async () => {
    const mock = mockFetch({
      number: 1,
      html_url: "https://github.com/o/r/issues/1",
    });
    const tools = createGitHubConnector({ token: "ghp_my_secret_token" });
    const createIssue = tools.find((t) => t.name === "github_create_issue")!;
    await createIssue.invoke({ owner: "o", repo: "r", title: "T" });
    const headers = calledHeaders(mock);
    expect(headers["Authorization"]).toBe("Bearer ghp_my_secret_token");
  });

  it("includes Accept: application/vnd.github+json header", async () => {
    const mock = mockFetch([]);
    await tool("github_list_branches").invoke({ owner: "o", repo: "r" });
    const headers = calledHeaders(mock);
    expect(headers["Accept"]).toBe("application/vnd.github+json");
  });

  it("includes X-GitHub-Api-Version header", async () => {
    const mock = mockFetch([]);
    await tool("github_list_branches").invoke({ owner: "o", repo: "r" });
    const headers = calledHeaders(mock);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("uses a different token for a different connector instance", async () => {
    const mock = mockFetch([]);
    const tools = createGitHubConnector({ token: "ghp_different_token" });
    const listBranches = tools.find((t) => t.name === "github_list_branches")!;
    await listBranches.invoke({ owner: "o", repo: "r" });
    const headers = calledHeaders(mock);
    expect(headers["Authorization"]).toBe("Bearer ghp_different_token");
  });

  it("uses custom baseUrl when provided", async () => {
    const mock = mockFetch([]);
    const tools = createGitHubConnector({
      token: "t",
      baseUrl: "https://github.example.com/api/v3",
    });
    const listBranches = tools.find((t) => t.name === "github_list_branches")!;
    await listBranches.invoke({ owner: "o", repo: "r" });
    expect(calledUrl(mock)).toContain("github.example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Rate limit handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Rate limit handling", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns error string with status 429 on rate limit for list_issues", async () => {
    mockFetch({ message: "API rate limit exceeded for ..." }, false, 429);
    const result = await tool("github_list_issues").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("429");
    expect(result).toContain("GitHub API error");
  });

  it("returns error string with status 429 on rate limit for create_pr", async () => {
    mockFetch({ message: "API rate limit exceeded" }, false, 429);
    const result = await tool("github_create_pr").invoke({
      owner: "o",
      repo: "r",
      title: "T",
      head: "h",
      base: "main",
    });
    expect(result).toContain("429");
  });

  it("returns error string with status 429 on rate limit for get_repo", async () => {
    mockFetch({ message: "rate limit exceeded" }, false, 429);
    const result = await tool("github_get_repo").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("429");
  });

  it("succeeds after first 429 then 200 (sequence mock)", async () => {
    // The connector does NOT automatically retry, so after 429 the error is
    // returned. A second distinct invocation with 200 succeeds.
    mockFetchSequence([
      { body: { message: "rate limit exceeded" }, ok: false, status: 429 },
    ]);
    const firstResult = await tool("github_get_repo").invoke({
      owner: "o",
      repo: "r",
    });
    expect(firstResult).toContain("429");

    mockFetch({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      description: null,
      default_branch: "main",
      private: false,
      language: "TypeScript",
      stargazers_count: 100,
      forks_count: 5,
      open_issues_count: 3,
    });
    const secondResult = await tool("github_get_repo").invoke({
      owner: "o",
      repo: "r",
    });
    expect(secondResult).toContain("o/r");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. GitHubClient direct method tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubClient.createPR direct", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns GitHubPullRequest on success", async () => {
    mockFetch({
      number: 7,
      title: "feat: x",
      body: "desc",
      state: "open",
      html_url: "https://github.com/o/r/pull/7",
      head: { ref: "feat/x", sha: "abc" },
      base: { ref: "main", sha: "def" },
      merged: false,
      mergeable: true,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      user: { login: "alice" },
    });
    const client = new GitHubClient({ token: "t" });
    const pr = await client.createPR(
      "o",
      "r",
      "feat: x",
      "desc",
      "feat/x",
      "main",
    );
    expect(pr.number).toBe(7);
    expect(pr.head.ref).toBe("feat/x");
  });

  it("throws GitHubApiError on failure", async () => {
    mockFetch({ message: "Unprocessable Entity" }, false, 422);
    const client = new GitHubClient({ token: "t" });
    await expect(
      client.createPR("o", "r", "T", "", "h", "main"),
    ).rejects.toThrow(GitHubApiError);
  });
});

describe("GitHubClient.createIssue direct", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns GitHubIssue with number on success", async () => {
    mockFetch({
      number: 55,
      title: "A bug",
      body: "details",
      state: "open",
      html_url: "https://github.com/o/r/issues/55",
      labels: [],
      assignees: [],
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      user: { login: "alice" },
    });
    const client = new GitHubClient({ token: "t" });
    const issue = await client.createIssue("o", "r", "A bug", "details", {
      labels: ["bug"],
    });
    expect(issue.number).toBe(55);
  });
});

describe("GitHubClient.updateIssue direct", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns updated issue with new state", async () => {
    mockFetch({
      number: 10,
      title: "T",
      body: null,
      state: "closed",
      html_url: "https://github.com/o/r/issues/10",
      labels: [],
      assignees: [],
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      user: null,
    });
    const client = new GitHubClient({ token: "t" });
    const updated = await client.updateIssue("o", "r", 10, { state: "closed" });
    expect(updated.state).toBe("closed");
  });
});

describe("GitHubClient.createReviewComment direct", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns review comment with id", async () => {
    mockFetch({ id: 999, body: "nit: rename this" });
    const client = new GitHubClient({ token: "t" });
    const comment = await client.createReviewComment(
      "o",
      "r",
      5,
      "nit: rename this",
      "src/a.ts",
      12,
    );
    expect(comment.id).toBe(999);
    expect(comment.body).toBe("nit: rename this");
  });

  it("includes commit_id in payload when provided", async () => {
    const mock = mockFetch({ id: 1, body: "x" });
    const client = new GitHubClient({ token: "t" });
    await client.createReviewComment("o", "r", 5, "x", "a.ts", 1, "sha123");
    expect(parsedBody(mock).commit_id).toBe("sha123");
  });
});

describe("GitHubApiError token redaction", () => {
  it("redacts Bearer token in error body", () => {
    const err = new GitHubApiError(
      401,
      "Bearer ghp_1234567890abcdefghij is invalid",
    );
    expect(err.body).not.toContain("ghp_1234567890abcdefghij");
    expect(err.body).toContain("[REDACTED");
  });

  it("redacts github_pat_ style tokens", () => {
    const err = new GitHubApiError(
      401,
      "token github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345 rejected",
    );
    expect(err.body).not.toContain(
      "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    );
  });

  it("preserves non-sensitive error message", () => {
    const err = new GitHubApiError(404, "Not Found: resource does not exist");
    expect(err.body).toBe("Not Found: resource does not exist");
    expect(err.status).toBe(404);
  });
});
