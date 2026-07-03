import type { DomainToolDefinition } from "../types.js";
import type {
  AnyExecutableDomainTool,
  ExecutableDomainTool,
} from "./shared.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface TodoStore {
  get(): TodoItem[];
  set(todos: TodoItem[]): void;
}

export class InMemoryTodoStore implements TodoStore {
  private todos: TodoItem[];

  constructor(initialTodos: TodoItem[] = []) {
    this.todos = cloneTodos(initialTodos);
  }

  get(): TodoItem[] {
    return cloneTodos(this.todos);
  }

  set(todos: TodoItem[]): void {
    this.todos = cloneTodos(todos);
  }
}

interface WriteTodosInput {
  todos: TodoItem[];
}

interface PlanTodosOutput {
  todos: TodoItem[];
  rendered: string;
}

type ReadTodosInput = Record<string, never>;

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
const MAX_TODOS = 50;

const todoItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "status"],
  properties: {
    content: { type: "string", minLength: 1 },
    status: { type: "string", enum: TODO_STATUSES },
  },
};

const planTodosOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["todos", "rendered"],
  properties: {
    todos: {
      type: "array",
      items: todoItemSchema,
      maxItems: MAX_TODOS,
    },
    rendered: { type: "string" },
  },
};

function cloneTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function isTodoStatus(status: unknown): status is TodoStatus {
  return (
    typeof status === "string" &&
    TODO_STATUSES.includes(status as TodoStatus)
  );
}

function assertTodoList(input: TodoItem[]): void {
  if (!Array.isArray(input)) {
    throw new Error("plan.write_todos requires todos to be an array");
  }
  if (input.length > MAX_TODOS) {
    throw new Error(`plan.write_todos accepts at most ${MAX_TODOS} todos`);
  }
  for (const [index, todo] of input.entries()) {
    if (
      todo === null ||
      typeof todo !== "object" ||
      typeof todo.content !== "string" ||
      todo.content.length === 0 ||
      !isTodoStatus(todo.status)
    ) {
      throw new Error(`plan.write_todos received invalid todo at index ${index}`);
    }
  }
  const inProgressCount = input.filter(
    (todo) => todo.status === "in_progress",
  ).length;
  if (inProgressCount > 1) {
    throw new Error(
      `plan.write_todos accepts exactly one task in_progress; found ${inProgressCount}`,
    );
  }
}

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "(todo list is empty)";
  }
  return todos
    .map((todo) => {
      const marker =
        todo.status === "completed"
          ? "[x]"
          : todo.status === "in_progress"
            ? "[>]"
            : "[ ]";
      return `${marker} ${todo.content}`;
    })
    .join("\n");
}

function buildPlanWriteTodos(
  store: TodoStore,
): ExecutableDomainTool<WriteTodosInput, PlanTodosOutput> {
  const definition: DomainToolDefinition = {
    name: "plan.write_todos",
    description: "Replace the current self-planning todo list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          items: todoItemSchema,
          maxItems: MAX_TODOS,
        },
      },
    },
    outputSchema: planTodosOutputSchema,
    permissionLevel: "read",
    sideEffects: [],
    namespace: "plan",
  };

  return {
    definition,
    async execute(input: WriteTodosInput): Promise<PlanTodosOutput> {
      assertTodoList(input.todos);
      const todos = cloneTodos(input.todos);
      store.set(todos);
      return { todos, rendered: renderTodos(todos) };
    },
  };
}

function buildPlanReadTodos(
  store: TodoStore,
): ExecutableDomainTool<ReadTodosInput, PlanTodosOutput> {
  const definition: DomainToolDefinition = {
    name: "plan.read_todos",
    description: "Read the current self-planning todo list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: planTodosOutputSchema,
    permissionLevel: "read",
    sideEffects: [],
    namespace: "plan",
  };

  return {
    definition,
    async execute(_input: ReadTodosInput): Promise<PlanTodosOutput> {
      const todos = store.get();
      return { todos, rendered: renderTodos(todos) };
    },
  };
}

export function buildPlanTools(store: TodoStore): AnyExecutableDomainTool[] {
  return [buildPlanWriteTodos(store), buildPlanReadTodos(store)];
}
