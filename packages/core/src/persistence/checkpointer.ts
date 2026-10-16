import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface CheckpointerConfig {
  type: "postgres" | "memory";
  connectionString?: string;
}

const POSTGRES_SAVER_MODULE = "@langchain/langgraph-checkpoint-postgres";

/**
 * Load the Postgres saver only when the postgres branch runs, so importing
 * `@dzupagent/core` never evaluates the Postgres checkpointer (or its `pg`
 * driver) for memory-only consumers.
 */
async function loadPostgresSaver(): Promise<
  typeof import("@langchain/langgraph-checkpoint-postgres").PostgresSaver
> {
  try {
    const mod = (await import(
      "@langchain/langgraph-checkpoint-postgres"
    )) as typeof import("@langchain/langgraph-checkpoint-postgres");
    return mod.PostgresSaver;
  } catch (cause) {
    throw new Error(
      `postgres checkpointer requires the optional package "${POSTGRES_SAVER_MODULE}"; install it to use type "postgres"`,
      { cause }
    );
  }
}

/**
 * Creates a LangGraph checkpointer based on the provided configuration.
 *
 * - `postgres`: Requires `connectionString`. Calls `setup()` to ensure
 *   checkpoint tables exist before returning. The Postgres saver module is
 *   loaded lazily on this branch only.
 * - `memory`: In-memory checkpointer for development / testing. Works without
 *   the Postgres saver module installed.
 *
 * @public Stable root export of `@dzupagent/core` (also available via the
 * `./persistence` subpath). Consumed in production by downstream apps;
 * treat signature and error contract as semver-facing.
 */
export async function createCheckpointer(
  config: CheckpointerConfig
): Promise<BaseCheckpointSaver> {
  if (config.type === "postgres") {
    if (!config.connectionString) {
      throw new Error("connectionString required for postgres checkpointer");
    }
    const PostgresSaver = await loadPostgresSaver();
    const saver = PostgresSaver.fromConnString(config.connectionString);
    await saver.setup();
    return saver;
  }

  return new MemorySaver();
}
