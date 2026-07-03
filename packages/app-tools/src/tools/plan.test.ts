import { describe, expect, it } from "vitest";
import {
  buildPlanTools,
  InMemoryTodoStore,
  type TodoItem,
} from "./plan.js";
import type {
  AnyExecutableDomainTool,
  ExecutableDomainTool,
} from "./shared.js";

interface PlanTodosOutput {
  todos: TodoItem[];
  rendered: string;
}

function findTool(
  tools: AnyExecutableDomainTool[],
  name: string,
): ExecutableDomainTool<Record<string, unknown>, unknown> {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not found`);
  }
  // Existential unpack: recover a callable signature for the named tool from
  // the heterogeneous AnyExecutableDomainTool collection.
  return tool as ExecutableDomainTool<Record<string, unknown>, unknown>;
}

describe("plan.write_todos", () => {
  it("replaces the full list, returns the accepted list, and renders status markers", async () => {
    const store = new InMemoryTodoStore();
    store.set([{ content: "old task", status: "pending" }]);
    const writeTodos = findTool(buildPlanTools(store), "plan.write_todos");

    const todos: TodoItem[] = [
      { content: "Ship red test", status: "completed" },
      { content: "Implement plan tools", status: "in_progress" },
      { content: "Run validation", status: "pending" },
    ];

    const result = (await writeTodos.execute({ todos })) as PlanTodosOutput;

    expect(result.todos).toEqual(todos);
    expect(store.get()).toEqual(todos);
    expect(result.rendered).toBe(
      [
        "[x] Ship red test",
        "[>] Implement plan tools",
        "[ ] Run validation",
      ].join("\n"),
    );
  });

  it("rejects more than one in_progress todo without mutating the store", async () => {
    const store = new InMemoryTodoStore();
    const existing: TodoItem[] = [{ content: "keep me", status: "pending" }];
    store.set(existing);
    const writeTodos = findTool(buildPlanTools(store), "plan.write_todos");

    await expect(
      writeTodos.execute({
        todos: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(/exactly one task in_progress/i);
    expect(store.get()).toEqual(existing);
  });

  it("rejects 51 todos with an error mentioning 50 and leaves the store unchanged", async () => {
    const store = new InMemoryTodoStore();
    const existing: TodoItem[] = [{ content: "keep me", status: "pending" }];
    store.set(existing);
    const writeTodos = findTool(buildPlanTools(store), "plan.write_todos");

    await expect(
      writeTodos.execute({
        todos: Array.from({ length: 51 }, (_, index) => ({
          content: `todo ${index + 1}`,
          status: "pending",
        })),
      }),
    ).rejects.toThrow(/50/);
    expect(store.get()).toEqual(existing);
  });
});

describe("plan.read_todos", () => {
  it("returns the current list", async () => {
    const store = new InMemoryTodoStore();
    const todos: TodoItem[] = [
      { content: "current task", status: "in_progress" },
      { content: "later task", status: "pending" },
    ];
    store.set(todos);
    const readTodos = findTool(buildPlanTools(store), "plan.read_todos");

    const result = (await readTodos.execute({})) as PlanTodosOutput;

    expect(result.todos).toEqual(todos);
    expect(result.rendered).toBe("[>] current task\n[ ] later task");
  });
});
