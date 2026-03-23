import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { MemorySaver } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph'

export interface CheckpointerConfig {
  type: 'postgres' | 'memory'
  connectionString?: string
}

/**
 * Creates a LangGraph checkpointer based on the provided configuration.
 *
 * - `postgres`: Requires `connectionString`. Calls `setup()` to ensure
 *   checkpoint tables exist before returning.
 * - `memory`: In-memory checkpointer for development / testing.
 */
export async function createCheckpointer(
  config: CheckpointerConfig,
): Promise<BaseCheckpointSaver> {
  if (config.type === 'postgres') {
    if (!config.connectionString) {
      throw new Error('connectionString required for postgres checkpointer')
    }
    const saver = PostgresSaver.fromConnString(config.connectionString)
    await saver.setup()
    return saver
  }

  return new MemorySaver()
}
