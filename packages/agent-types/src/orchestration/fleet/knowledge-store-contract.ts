/**
 * Shared KnowledgeStore conformance contract — framework-free.
 *
 * This module deliberately imports NOTHING but types. It carries no `describe`
 * / `it` / `expect` at module scope, so it survives the normal build into
 * `dist` and is importable across the package boundary as
 * `@dzupagent/agent-types/fleet-contract`.
 *
 * The previous shape of this suite called vitest's globals directly, which
 * meant it could only ever be reached by a deep relative path into this
 * package's *source* tree (`../../agent-types/src/.../*.test.js`). That import
 * dragged agent-types sources under the consumer's `rootDir` and forced
 * `packages/memory/tsconfig.flipcheck.json` to widen `rootDir` to `".."`.
 *
 * Consumers supply their own test-runner bindings:
 *
 *   import { knowledgeStoreContractCases } from "@dzupagent/agent-types/fleet-contract";
 *
 *   describe("KnowledgeStore contract: MyStore", () => {
 *     for (const testCase of knowledgeStoreContractCases) {
 *       it(testCase.name, () => testCase.run(async () => new MyStore()));
 *     }
 *   });
 *
 * A case signals failure by throwing. Any runner that fails a test on a thrown
 * error therefore reports contract violations without further adaptation.
 */
import type {
  FindingPayload,
  KnowledgeEnvelope,
  LessonPayload,
} from "./fleet-types.js";
import type { KnowledgeStore } from "./knowledge-store.js";

/** Produces a fresh, empty store. Called once per case. */
export type KnowledgeStoreFactory = () => Promise<KnowledgeStore>;

export interface KnowledgeStoreContractCase {
  /** Stable, human-readable case name — safe to use as a test title. */
  readonly name: string;
  /** Throws (or rejects) when the store under test violates the contract. */
  readonly run: (factory: KnowledgeStoreFactory) => Promise<void>;
}

/** Thrown when a store under test violates the contract. */
export class KnowledgeStoreContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeStoreContractViolation";
  }
}

function fail(message: string): never {
  throw new KnowledgeStoreContractViolation(message);
}

function assertTruthy(value: unknown, message: string): void {
  if (!value) {
    fail(`${message} (got ${JSON.stringify(value ?? null)})`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    fail(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual
      )}`
    );
  }
}

function assertContains(
  haystack: readonly string[],
  needle: string,
  message: string
): void {
  if (!haystack.includes(needle)) {
    fail(`${message}: ${JSON.stringify(haystack)} does not contain "${needle}"`);
  }
}

function assertNotContains(
  haystack: readonly string[],
  needle: string,
  message: string
): void {
  if (haystack.includes(needle)) {
    fail(
      `${message}: ${JSON.stringify(haystack)} unexpectedly contains "${needle}"`
    );
  }
}

async function assertRejectsWith(
  operation: () => Promise<unknown>,
  pattern: RegExp,
  message: string
): Promise<void> {
  let outcome: unknown;
  try {
    outcome = await operation();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!pattern.test(text)) {
      fail(`${message}: rejected, but with a non-matching error "${text}"`);
    }
    return;
  }
  fail(
    `${message}: resolved with ${JSON.stringify(outcome ?? null)} instead of rejecting`
  );
}

/**
 * Yield to the macrotask queue so a store that notifies subscribers
 * asynchronously has a chance to run.
 *
 * `setTimeout` is reached through `globalThis` on purpose: this package
 * compiles with `"types": []` and no DOM/node lib, so referencing the global
 * directly breaks the declaration build.
 */
async function delay(ms: number): Promise<void> {
  const schedule = (
    globalThis as {
      setTimeout?: (callback: () => void, ms: number) => unknown;
    }
  ).setTimeout;
  if (typeof schedule !== "function") return;
  await new Promise<void>((resolve) => {
    schedule(() => resolve(), ms);
  });
}

function findingPayload(): FindingPayload {
  return {
    category: "hotspot",
    location: "a:1",
    summary: "",
    evidence: [],
    confidence: 1,
  };
}

function lessonPayload(): LessonPayload {
  return {
    scope: "this-run",
    rule: "r",
    why: "w",
    howToApply: "h",
    evidenceLinks: [],
  };
}

function envelope(
  overrides: Partial<KnowledgeEnvelope> = {}
): KnowledgeEnvelope {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    runId: "run1",
    repo: null,
    kind: "finding",
    key: "k",
    version: 1,
    authorWorkerId: null,
    parentId: null,
    createdAt: new Date().toISOString(),
    supersededAt: null,
    payload: findingPayload(),
    tags: [],
    ...overrides,
  };
}

export const knowledgeStoreContractCases: readonly KnowledgeStoreContractCase[] =
  [
    {
      name: "append returns a ref with id and version",
      run: async (factory) => {
        const store = await factory();
        const ref = await store.append(
          "run:run1",
          envelope({ kind: "finding", key: "k1", version: 1 })
        );
        assertTruthy(ref?.id, "append() must return a ref carrying an id");
        assertEqual(ref.version, 1, "append() must echo the entry version");
      },
    },
    {
      name: "read returns the latest non-superseded entry for (kind,key)",
      run: async (factory) => {
        const store = await factory();
        await store.append(
          "run:run1",
          envelope({ kind: "finding", key: "k2", version: 1 })
        );
        await store.append(
          "run:run1",
          envelope({ kind: "finding", key: "k2", version: 2 })
        );
        const got = await store.read("run:run1", "finding", "k2");
        assertEqual(
          got?.version,
          2,
          "read() must return the highest live version for (kind,key)"
        );
      },
    },
    {
      name: "append rejects on (scope, kind, key, version) collision",
      run: async (factory) => {
        const store = await factory();
        await store.append(
          "run:run1",
          envelope({ kind: "finding", key: "k3", version: 1 })
        );
        await assertRejectsWith(
          () =>
            store.append(
              "run:run1",
              envelope({ kind: "finding", key: "k3", version: 1 })
            ),
          /collision|exists|conflict/i,
          "a second distinct entry at the same (scope,kind,key,version) must be rejected"
        );
      },
    },
    {
      name: "query yields entries matching kind filter",
      run: async (factory) => {
        const store = await factory();
        await store.append(
          "run:run1",
          envelope({ kind: "finding", key: "q1", version: 1 })
        );
        await store.append(
          "run:run1",
          envelope({
            kind: "lesson",
            key: "q2",
            version: 1,
            payload: lessonPayload(),
          })
        );
        const results: KnowledgeEnvelope[] = [];
        for await (const entry of store.query({
          scope: "run:run1",
          kind: "finding",
        })) {
          results.push(entry);
        }
        const keys = results.map((r) => r.key);
        assertContains(keys, "q1", "query() must yield the matching kind");
        assertNotContains(
          keys,
          "q2",
          "query() must not yield a non-matching kind"
        );
      },
    },
    {
      name: "subscribe invokes handler for new matching entries",
      run: async (factory) => {
        const store = await factory();
        const seen: string[] = [];
        const unsubscribe = store.subscribe(
          { scope: "run:run1", kind: "finding" },
          (entry) => {
            seen.push(entry.key);
          }
        );
        try {
          await store.append(
            "run:run1",
            envelope({ kind: "finding", key: "sub1", version: 1 })
          );
          await delay(50);
        } finally {
          unsubscribe();
        }
        assertContains(
          seen,
          "sub1",
          "subscribe() must notify the handler of a matching append"
        );
      },
    },
  ];
