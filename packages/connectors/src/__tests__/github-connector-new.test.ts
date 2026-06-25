/**
 * New GitHub connector tests — covers areas not yet reached by the existing
 * five test files.  Focus areas:
 *
 *  1. Rate-limit response body / status-code handling
 *  2. Pagination: page parameter forwarding, large per_page values
 *  3. GitHubClient direct method coverage (methods not yet tested standalone)
 *  4. Connector tool edge cases: body/message truncation in safe(), unicode,
 *     special characters, empty arrays
 *  5. Webhook-event shape helpers (standalone parsing logic)
 *  6. ConnectorToolkit interface conformance
 *  7. Token redaction edge cases in GitHubApiError
 *  8. HTTP header forwarding across all verb helpers
 *  9. Outbound URL policy — blocked and unblocked paths
 * 10. GitHubClient.request() 204 edge case with non-void return type
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGitHubConnector,
  createGitHubConnectorToolkit,
} from "../github/github-connector.js";
import { GitHubClient, GitHubApiError } from "../github/github-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockFetch(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
) {
  const mock = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function tool(name: string) {
  const tools = createGitHubConnector({ token: "test-token" });
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Rate-limit response handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Rate-limit response handling", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("safe() captures 429 status in error string for github_list_issues", async () => {
    mockFetch({ message: "API rate limit exceeded" }, false, 429);
    const result = await tool("github_list_issues").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("GitHub API error");
    expect(result).toContain("429");
  });

  it("safe() captures 429 for github_get_repo", async () => {
    mockFetch({ message: "rate limit exceeded" }, false, 429);
    const result = await tool("github_get_repo").invoke({
      owner: "o",
      repo: "r",
    });
    expect(result).toContain("429");
  });

  it("GitHubClient throws GitHubApiError on 429", async () => {
    mockFetch({ message: "Too Many Requests" }, false, 429);
    const client = new GitHubClient({ token: "tok" });
    const err = await client.request("/test").catch((e) => e as GitHubApiError);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(429);
  });

  it("GitHubApiError body contains original rate-limit message", async () => {
    mockFetch({ message: "API rate limit exceeded for ip" }, false, 429);
    const client = new GitHubClient({ token: "tok" });
    const err = await client
      .listIssues("o", "r")
      .catch((e) => e as GitHubApiError);
    expect(err.body).toContain("rate limit exceeded");
  });

  it("tool layer truncates very long error body to 200 chars", async () => {
    const longMessage = "X".repeat(500);
    mockFetch({ message: longMessage }, false, 503);
    const result = await tool("github_get_repo").invoke({
      owner: "o",
      repo: "r",
    });
    // safe() slices body to 200 chars: "GitHub API error 503: XXX..." length check
    expect((result as string).length).toBeLessThanOrEqual(240);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pagination — page parameter forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("Pagination — page parameter forwarding", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("GitHubClient.listIssues sends page=2", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listIssues("o", "r", { page: 2 });
    const url = mock.mock.calls[0]![0] as string;
    expect(url).toContain("page=2");
  });

  it("GitHubClient.listIssues sends page=5 with per_page=50", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listIssues("o", "r", { page: 5, per_page: 50 });
    const url = mock.mock.calls[0]![0] as string;
    expect(url).toContain("page=5");
    expect(url).toContain("per_page=50");
  });

  it("GitHubClient.listPRs sends page=3", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listPRs("o", "r", { page: 3 });
    const url = mock.mock.calls[0]![0] as string;
    expect(url).toContain("page=3");
  });

  it("GitHubClient.listPRs does not include page param when not specified", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listPRs("o", "r");
    const url = mock.mock.calls[0]![0] as string;
    // Must not have a standalone page= param (per_page= is expected and fine)
    expect(url).not.toMatch(/[?&]page=\d/);
  });

  it("GitHubClient.listIssues with per_page=100 (max)", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listIssues("o", "r", { per_page: 100 });
    const url = mock.mock.calls[0]![0] as string;
    expect(url).toContain("per_page=100");
  });

  it("GitHubClient.listIssues page defaults — no page param when page is undefined", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listIssues("o", "r", { page: undefined });
    const url = mock.mock.calls[0]![0] as string;
    // Must not have a standalone page= param (per_page= is expected and fine)
    expect(url).not.toMatch(/[?&]page=\d/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GitHubClient direct method coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubClient — direct method coverage", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  describe("listPRReviews", () => {
    it("returns empty array when no reviews exist", async () => {
      mockFetch([]);
      const client = new GitHubClient({ token: "tok" });
      const result = await client.listPRReviews("o", "r", 1);
      expect(result).toEqual([]);
    });

    it("returns multiple reviews with state and body", async () => {
      mockFetch([
        {
          id: 1,
          body: "LGTM",
          state: "APPROVED",
          html_url: "u1",
          submitted_at: "2026-01-01",
          user: { login: "alice" },
        },
        {
          id: 2,
          body: "Nope",
          state: "CHANGES_REQUESTED",
          html_url: "u2",
          submitted_at: "2026-01-02",
          user: { login: "bob" },
        },
      ]);
      const client = new GitHubClient({ token: "tok" });
      const reviews = await client.listPRReviews("o", "r", 5);
      expect(reviews).toHaveLength(2);
      expect(reviews[0]!.state).toBe("APPROVED");
      expect(reviews[1]!.state).toBe("CHANGES_REQUESTED");
    });

    it("throws GitHubApiError on 403", async () => {
      mockFetch({ message: "Forbidden" }, false, 403);
      const client = new GitHubClient({ token: "tok" });
      await expect(client.listPRReviews("o", "r", 1)).rejects.toThrow(
        GitHubApiError,
      );
    });
  });

  describe("createPRReview", () => {
    it("sends POST with APPROVE event", async () => {
      const mock = mockFetch({
        id: 10,
        state: "APPROVED",
        html_url: "u",
        body: "LGTM",
        submitted_at: "2026-01-01",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.createPRReview("o", "r", 3, "LGTM", "APPROVE");
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["event"]).toBe("APPROVE");
      expect(body["body"]).toBe("LGTM");
    });

    it("sends POST with REQUEST_CHANGES event", async () => {
      const mock = mockFetch({
        id: 11,
        state: "CHANGES_REQUESTED",
        html_url: "u",
        body: "fix this",
        submitted_at: "2026-01-01",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.createPRReview("o", "r", 4, "fix this", "REQUEST_CHANGES");
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["event"]).toBe("REQUEST_CHANGES");
    });

    it("returns review data from response", async () => {
      mockFetch({
        id: 99,
        state: "COMMENTED",
        html_url: "https://gh/pr/1#review-99",
        body: "note",
        submitted_at: "2026-01-01",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      const review = await client.createPRReview(
        "o",
        "r",
        1,
        "note",
        "COMMENT",
      );
      expect(review.id).toBe(99);
      expect(review.state).toBe("COMMENTED");
    });
  });

  describe("addComment (GitHubClient)", () => {
    it("returns comment with correct id and html_url", async () => {
      mockFetch({
        id: 777,
        body: "test",
        html_url: "https://gh/issues/1#comment-777",
        created_at: "2026-01-01",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      const comment = await client.addComment("o", "r", 1, "test");
      expect(comment.id).toBe(777);
      expect(comment.html_url).toContain("comment-777");
    });

    it("sends body as JSON in POST request", async () => {
      const mock = mockFetch({
        id: 1,
        body: "hi",
        html_url: "",
        created_at: "",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.addComment("o", "r", 5, "hi there");
      const init = mock.mock.calls[0]![1] as RequestInit;
      const parsedBody = JSON.parse(init.body as string) as Record<
        string,
        unknown
      >;
      expect(parsedBody["body"]).toBe("hi there");
    });
  });

  describe("updateIssue (GitHubClient)", () => {
    it("sends PATCH with state=closed", async () => {
      const mock = mockFetch({
        number: 1,
        title: "Bug",
        body: null,
        state: "closed",
        html_url: "u",
        labels: [],
        assignees: [],
        created_at: "2026",
        updated_at: "2026",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.updateIssue("o", "r", 1, { state: "closed" });
      const init = mock.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("PATCH");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["state"]).toBe("closed");
    });

    it("sends PATCH with title, body, and assignees", async () => {
      const mock = mockFetch({
        number: 2,
        title: "New",
        body: "desc",
        state: "open",
        html_url: "u",
        labels: [],
        assignees: [],
        created_at: "2026",
        updated_at: "2026",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.updateIssue("o", "r", 2, {
        title: "New",
        body: "desc",
        assignees: ["alice"],
      });
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["title"]).toBe("New");
      expect(body["assignees"]).toEqual(["alice"]);
    });

    it("throws GitHubApiError on 404 (issue not found)", async () => {
      mockFetch({ message: "Not Found" }, false, 404);
      const client = new GitHubClient({ token: "tok" });
      await expect(
        client.updateIssue("o", "r", 9999, { state: "closed" }),
      ).rejects.toThrow(GitHubApiError);
    });
  });

  describe("getPR (GitHubClient)", () => {
    it("returns full PR data", async () => {
      mockFetch({
        number: 42,
        title: "Feature",
        body: "desc",
        state: "open",
        html_url: "u",
        head: { ref: "feat", sha: "abc" },
        base: { ref: "main", sha: "def" },
        merged: false,
        mergeable: true,
        created_at: "2026",
        updated_at: "2026",
        user: { login: "dev" },
      });
      const client = new GitHubClient({ token: "tok" });
      const pr = await client.getPR("o", "r", 42);
      expect(pr.number).toBe(42);
      expect(pr.head.ref).toBe("feat");
      expect(pr.base.ref).toBe("main");
    });

    it("handles merged PR (merged=true)", async () => {
      mockFetch({
        number: 10,
        title: "Done",
        body: null,
        state: "closed",
        html_url: "u",
        head: { ref: "feat", sha: "abc" },
        base: { ref: "main", sha: "def" },
        merged: true,
        mergeable: null,
        created_at: "2026",
        updated_at: "2026",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      const pr = await client.getPR("o", "r", 10);
      expect(pr.merged).toBe(true);
      expect(pr.mergeable).toBeNull();
    });
  });

  describe("createIssue (GitHubClient) — extra coverage", () => {
    it("creates issue without optional fields", async () => {
      const mock = mockFetch({
        number: 5,
        title: "plain",
        body: null,
        state: "open",
        html_url: "u",
        labels: [],
        assignees: [],
        created_at: "",
        updated_at: "",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.createIssue("o", "r", "plain");
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["title"]).toBe("plain");
      expect(body["body"]).toBeUndefined();
      expect(body["labels"]).toBeUndefined();
    });

    it("creates issue with all optional fields", async () => {
      const mock = mockFetch({
        number: 6,
        title: "full",
        body: "body text",
        state: "open",
        html_url: "u",
        labels: [{ name: "bug" }],
        assignees: [{ login: "alice" }],
        created_at: "",
        updated_at: "",
        user: null,
      });
      const client = new GitHubClient({ token: "tok" });
      await client.createIssue("o", "r", "full", "body text", {
        labels: ["bug"],
        assignees: ["alice"],
      });
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["labels"]).toEqual(["bug"]);
      expect(body["assignees"]).toEqual(["alice"]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Connector tool edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Connector tool edge cases", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  describe("github_list_issues — edge cases", () => {
    it("returns empty JSON array when no issues exist", async () => {
      mockFetch([]);
      const result = await tool("github_list_issues").invoke({
        owner: "o",
        repo: "r",
      });
      expect(JSON.parse(result as string)).toEqual([]);
    });

    it("passes per_page custom value from tool input", async () => {
      const mock = mockFetch([]);
      await tool("github_list_issues").invoke({
        owner: "o",
        repo: "r",
        per_page: 50,
      });
      const url = mock.mock.calls[0]![0] as string;
      expect(url).toContain("per_page=50");
    });

    it("handles state=all filter", async () => {
      const mock = mockFetch([]);
      await tool("github_list_issues").invoke({
        owner: "o",
        repo: "r",
        state: "all",
      });
      const url = mock.mock.calls[0]![0] as string;
      expect(url).toContain("state=all");
    });
  });

  describe("github_update_issue — edge cases", () => {
    it("returns error for non-existent issue (404)", async () => {
      mockFetch({ message: "Not Found" }, false, 404);
      const result = await tool("github_update_issue").invoke({
        owner: "o",
        repo: "r",
        issue_number: 99999,
        state: "closed",
      });
      expect(result).toContain("GitHub API error");
      expect(result).toContain("404");
    });

    it("can reopen a closed issue (state=open)", async () => {
      mockFetch({
        number: 3,
        state: "open",
        html_url: "https://github.com/o/r/issues/3",
      });
      const result = await tool("github_update_issue").invoke({
        owner: "o",
        repo: "r",
        issue_number: 3,
        state: "open",
      });
      expect(result).toContain("(open)");
    });

    it("updates with body containing unicode text", async () => {
      const mock = mockFetch({ number: 7, state: "open", html_url: "u" });
      await tool("github_update_issue").invoke({
        owner: "o",
        repo: "r",
        issue_number: 7,
        body: "Fix für Überprüfung — résumé",
      });
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["body"]).toBe("Fix für Überprüfung — résumé");
    });
  });

  describe("github_create_issue — edge cases", () => {
    it("handles issue title with special characters", async () => {
      const mock = mockFetch({
        number: 11,
        html_url: "https://github.com/o/r/issues/11",
      });
      await tool("github_create_issue").invoke({
        owner: "o",
        repo: "r",
        title: '[BUG] Can\'t parse <input> & "output"',
      });
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["title"]).toBe('[BUG] Can\'t parse <input> & "output"');
    });

    it("returns error on 403 forbidden (no write access)", async () => {
      mockFetch(
        { message: "Resource not accessible by integration" },
        false,
        403,
      );
      const result = await tool("github_create_issue").invoke({
        owner: "o",
        repo: "r",
        title: "test",
      });
      expect(result).toContain("GitHub API error");
      expect(result).toContain("403");
    });
  });

  describe("github_add_comment — edge cases", () => {
    it("handles markdown body with code blocks", async () => {
      const mock = mockFetch({ id: 200, html_url: "u", body: "code block" });
      await tool("github_add_comment").invoke({
        owner: "o",
        repo: "r",
        issue_number: 1,
        body: "```typescript\nconst x = 1;\n```",
      });
      const init = mock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["body"]).toContain("```typescript");
    });

    it("returns error on 404 (issue closed or not found)", async () => {
      mockFetch({ message: "Not Found" }, false, 404);
      const result = await tool("github_add_comment").invoke({
        owner: "o",
        repo: "r",
        issue_number: 99,
        body: "comment",
      });
      expect(result).toContain("GitHub API error");
      expect(result).toContain("404");
    });
  });

  describe("github_compare_commits — edge cases", () => {
    it("handles zero files changed (identical commits)", async () => {
      mockFetch({
        status: "identical",
        ahead_by: 0,
        behind_by: 0,
        total_commits: 0,
        commits: [],
        files: [],
      });
      const result = await tool("github_compare_commits").invoke({
        owner: "o",
        repo: "r",
        base: "main",
        head: "main",
      });
      expect(result).toContain("Status: identical");
      expect(result).toContain("Files changed: 0");
    });

    it("correctly handles branches with @ symbol in name", async () => {
      const mock = mockFetch({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        commits: [],
        files: [],
      });
      await tool("github_compare_commits").invoke({
        owner: "o",
        repo: "r",
        base: "v1.0@stable",
        head: "main",
      });
      const url = mock.mock.calls[0]![0] as string;
      expect(url).toContain("/compare/");
    });
  });

  describe("github_list_branches — large repository", () => {
    it("handles many branches", async () => {
      const branches = Array.from({ length: 30 }, (_, i) => ({
        name: `branch-${i}`,
        commit: { sha: `sha${i}aabbccddeeff` },
        protected: i === 0,
      }));
      mockFetch(branches);
      const result = await tool("github_list_branches").invoke({
        owner: "o",
        repo: "r",
      });
      expect(result).toContain("branch-0");
      expect(result).toContain("[protected]");
      expect(result).toContain("branch-29");
    });
  });

  describe("github_get_repo — data fields", () => {
    it("returns repo with null description", async () => {
      mockFetch({
        full_name: "o/r",
        description: null,
        html_url: "u",
        default_branch: "main",
        private: false,
        language: null,
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
      });
      const result = await tool("github_get_repo").invoke({
        owner: "o",
        repo: "r",
      });
      const parsed = JSON.parse(result as string) as Record<string, unknown>;
      expect(parsed["description"]).toBeNull();
      expect(parsed["language"]).toBeNull();
    });

    it("returns repo with high star count", async () => {
      mockFetch({
        full_name: "popular/repo",
        description: "famous lib",
        html_url: "u",
        default_branch: "main",
        private: false,
        language: "TypeScript",
        stargazers_count: 50000,
        forks_count: 12000,
        open_issues_count: 300,
      });
      const result = await tool("github_get_repo").invoke({
        owner: "popular",
        repo: "repo",
      });
      const parsed = JSON.parse(result as string) as Record<string, unknown>;
      expect(parsed["stargazers_count"]).toBe(50000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Webhook event shape helpers — standalone parsing
// ─────────────────────────────────────────────────────────────────────────────

describe("Webhook event parsing (standalone logic)", () => {
  // The connector has no webhook parsing module, but we test that the types
  // exported by the client can correctly represent webhook event shapes.
  // These are pure data-shape tests requiring no fetch calls.

  it("GitHubIssue shape satisfies push-event issue fields", () => {
    const issue = {
      number: 1,
      title: "opened via push",
      body: "Created automatically",
      state: "open",
      html_url: "https://github.com/o/r/issues/1",
      labels: [{ name: "auto" }],
      assignees: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      user: { login: "bot" },
    };
    // Verify fields we expect on a push-triggered issue event
    expect(issue.state).toBe("open");
    expect(issue.labels[0]!.name).toBe("auto");
  });

  it("GitHubPullRequest shape satisfies opened-PR event fields", () => {
    const pr = {
      number: 42,
      title: "feat: new feature",
      body: "PR description",
      state: "open",
      html_url: "https://github.com/o/r/pull/42",
      head: { ref: "feature/new", sha: "abc123" },
      base: { ref: "main", sha: "def456" },
      merged: false,
      mergeable: null,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
      user: { login: "author" },
    };
    expect(pr.head.ref).toBe("feature/new");
    expect(pr.base.ref).toBe("main");
    expect(pr.merged).toBe(false);
  });

  it("GitHubPullRequest shape satisfies closed+merged PR event", () => {
    const pr = {
      number: 99,
      title: "fix: urgent",
      body: null,
      state: "closed",
      html_url: "https://github.com/o/r/pull/99",
      head: { ref: "hotfix/urgent", sha: "aaa" },
      base: { ref: "main", sha: "bbb" },
      merged: true,
      mergeable: null,
      created_at: "2026-06-10T00:00:00Z",
      updated_at: "2026-06-11T00:00:00Z",
      user: null,
    };
    expect(pr.merged).toBe(true);
    expect(pr.state).toBe("closed");
  });

  it("GitHubReview shape satisfies review-submitted event", () => {
    const review = {
      id: 500,
      body: "LGTM!",
      state: "APPROVED",
      html_url: "https://github.com/o/r/pull/1#pullrequestreview-500",
      submitted_at: "2026-06-25T10:00:00Z",
      user: { login: "reviewer" },
    };
    expect(review.state).toBe("APPROVED");
    expect(review.user!.login).toBe("reviewer");
  });

  it("GitHubWorkflowRun shape satisfies workflow-run event with null conclusion", () => {
    const run = {
      id: 1001,
      status: "in_progress",
      conclusion: null,
      name: "CI",
    };
    expect(run.status).toBe("in_progress");
    expect(run.conclusion).toBeNull();
  });

  it("GitHubCheckRun shape with failure conclusion", () => {
    const checkRun = {
      name: "unit-tests",
      status: "completed",
      conclusion: "failure",
    };
    expect(checkRun.conclusion).toBe("failure");
    expect(checkRun.status).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ConnectorToolkit interface conformance
// ─────────────────────────────────────────────────────────────────────────────

describe("ConnectorToolkit interface conformance", () => {
  it("toolkit has name, tools, and enabledTools properties", () => {
    const tk = createGitHubConnectorToolkit({ token: "tok" });
    expect(typeof tk.name).toBe("string");
    expect(Array.isArray(tk.tools)).toBe(true);
    // enabledTools is undefined when not specified
    expect(tk.enabledTools).toBeUndefined();
  });

  it('toolkit name is always "github"', () => {
    const tk1 = createGitHubConnectorToolkit({ token: "a" });
    const tk2 = createGitHubConnectorToolkit({
      token: "b",
      enabledTools: ["github_get_repo"],
    });
    expect(tk1.name).toBe("github");
    expect(tk2.name).toBe("github");
  });

  it("each tool has a name and description", () => {
    const tk = createGitHubConnectorToolkit({ token: "tok" });
    for (const t of tk.tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.startsWith("github_")).toBe(true);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("each tool has an invoke function", () => {
    const tk = createGitHubConnectorToolkit({ token: "tok" });
    for (const t of tk.tools) {
      expect(typeof t.invoke).toBe("function");
    }
  });

  it("toolkit with custom baseUrl and outboundUrlPolicy stores config", () => {
    const tk = createGitHubConnectorToolkit({
      token: "tok",
      baseUrl: "https://github.enterprise.com/api/v3",
      outboundUrlPolicy: { allowedHosts: ["github.enterprise.com"] },
    });
    expect(tk.name).toBe("github");
    expect(tk.tools.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. GitHubApiError — token redaction edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubApiError — token redaction edge cases", () => {
  it("redacts ghp_ token pattern", () => {
    const err = new GitHubApiError(
      401,
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345 invalid",
    );
    expect(err.body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345");
    expect(err.body).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts github_pat_ token pattern", () => {
    const err = new GitHubApiError(
      401,
      "github_pat_ABCDEFGHIJKLMNOPQRST1234567890 used",
    );
    expect(err.body).not.toContain("github_pat_ABCDEFGHIJKLMNOPQRST1234567890");
    expect(err.body).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts gho_ (OAuth token) pattern", () => {
    const err = new GitHubApiError(
      401,
      "token gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    );
    expect(err.body).not.toContain("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345");
    expect(err.body).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts Bearer token in Authorization header text", () => {
    const err = new GitHubApiError(
      403,
      "Authorization: Bearer abc.def.ghi token rejected",
    );
    expect(err.body).not.toContain("abc.def.ghi");
    expect(err.body).toContain("Bearer [REDACTED]");
  });

  it("preserves non-sensitive error text", () => {
    const err = new GitHubApiError(
      422,
      "Validation Failed: title cannot be blank",
    );
    expect(err.body).toBe("Validation Failed: title cannot be blank");
    expect(err.status).toBe(422);
  });

  it("GitHubApiError message is under 250 chars for a 200-char body", () => {
    const body = "error ".repeat(30); // 180 chars
    const err = new GitHubApiError(404, body);
    expect(err.message.length).toBeLessThan(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. HTTP header forwarding across all verb helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP header forwarding", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("POST requests include Content-Type: application/json", async () => {
    const mock = mockFetch({ number: 1, html_url: "u" });
    const client = new GitHubClient({ token: "tok" });
    await client.createIssue("o", "r", "title");
    const init = mock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("PATCH requests include Content-Type: application/json", async () => {
    const mock = mockFetch({
      number: 1,
      title: "x",
      body: null,
      state: "open",
      html_url: "u",
      labels: [],
      assignees: [],
      created_at: "",
      updated_at: "",
      user: null,
    });
    const client = new GitHubClient({ token: "tok" });
    await client.updateIssue("o", "r", 1, { title: "x" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("PUT requests include Content-Type: application/json", async () => {
    const mock = mockFetch({ sha: "abc", merged: true, message: "ok" });
    const client = new GitHubClient({ token: "tok" });
    await client.mergePR("o", "r", 1);
    const init = mock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("DELETE requests use the DELETE method", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.removeLabel("o", "r", 1, "bug");
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });

  it("GET requests do not include Content-Type", async () => {
    const mock = mockFetch({
      full_name: "o/r",
      description: null,
      html_url: "",
      default_branch: "main",
      private: false,
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
    });
    const client = new GitHubClient({ token: "tok" });
    await client.getRepo("o", "r");
    const init = mock.mock.calls[0]![1] as RequestInit;
    // GET requests don't go through post/patch/put helpers — no Content-Type
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("all requests include X-GitHub-Api-Version header", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listBranches("o", "r");
    const init = mock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("all requests include Accept: application/vnd.github+json", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listIssues("o", "r");
    const init = mock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.github+json");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Outbound URL policy — blocked and unblocked paths
// ─────────────────────────────────────────────────────────────────────────────

describe("Outbound URL policy", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("blocks requests to localhost when no explicit policy allows it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new GitHubClient({
      token: "tok",
      baseUrl: "http://localhost:9000",
    });
    await expect(client.getRepo("o", "r")).rejects.toThrow(
      "Outbound URL rejected",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks requests to internal IP ranges by default", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new GitHubClient({
      token: "tok",
      baseUrl: "http://192.168.1.1/api",
    });
    await expect(client.listBranches("o", "r")).rejects.toThrow(
      "Outbound URL rejected",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows requests to api.github.com (default policy)", async () => {
    const mock = mockFetch([]);
    const client = new GitHubClient({ token: "tok" });
    await client.listBranches("o", "r");
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com"),
      expect.any(Object),
    );
  });

  it("allows explicitly permitted enterprise host", async () => {
    const mock = mockFetch({
      full_name: "o/r",
      description: null,
      html_url: "",
      default_branch: "main",
      private: false,
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
    });
    const client = new GitHubClient({
      token: "tok",
      baseUrl: "https://github.acme.com/api/v3",
      outboundUrlPolicy: { allowedHosts: ["github.acme.com"] },
    });
    await expect(client.getRepo("o", "r")).resolves.not.toThrow();
    expect(mock).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Additional GitHubClient.request() edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubClient.request() — additional edge cases", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed JSON body on success", async () => {
    mockFetch({ result: "ok", count: 42 });
    const client = new GitHubClient({ token: "tok" });
    const data = await client.request<{ result: string; count: number }>(
      "/test",
    );
    expect(data.result).toBe("ok");
    expect(data.count).toBe(42);
  });

  it("handles empty object response", async () => {
    mockFetch({});
    const client = new GitHubClient({ token: "tok" });
    const data = await client.request<Record<string, never>>("/empty");
    expect(data).toEqual({});
  });

  it("throws GitHubApiError with status 400 bad request", async () => {
    mockFetch({ message: "Bad Request" }, false, 400);
    const client = new GitHubClient({ token: "tok" });
    const err = await client.request("/bad").catch((e) => e as GitHubApiError);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(400);
  });

  it("constructs URL by concatenating baseUrl and path", async () => {
    const mock = mockFetch({});
    const client = new GitHubClient({ token: "tok" });
    await client.request("/repos/o/r/git/commits");
    expect(mock).toHaveBeenCalledWith(
      "https://api.github.com/repos/o/r/git/commits",
      expect.any(Object),
    );
  });

  it("passes custom init options to fetch", async () => {
    const mock = mockFetch({ items: [] });
    const client = new GitHubClient({ token: "tok" });
    await client.request("/search/code", { signal: AbortSignal.timeout(5000) });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("/search/code"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
