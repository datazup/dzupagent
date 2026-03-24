/**
 * Multi-agent orchestration patterns.
 *
 * Provides composable patterns for coordinating multiple ForgeAgent instances:
 * - Sequential: A → B → C (pipeline)
 * - Parallel: A, B, C concurrently, results merged
 * - Supervisor: Manager delegates to specialists via tool calling
 * - Debate: Multiple proposers, judge selects best
 */
import type { BaseMessage } from '@langchain/core/messages'
import { HumanMessage } from '@langchain/core/messages'
import type { ForgeAgent } from '../agent/forge-agent.js'

export type MergeFn = (results: string[]) => string | Promise<string>

const defaultMerge: MergeFn = (results) =>
  results.map((r, i) => `--- Agent ${i + 1} ---\n${r}`).join('\n\n')

export class AgentOrchestrator {
  /**
   * Run agents sequentially — each receives the previous agent's output.
   */
  static async sequential(
    agents: ForgeAgent[],
    initialInput: string,
  ): Promise<string> {
    let current = initialInput
    for (const agent of agents) {
      const result = await agent.generate([new HumanMessage(current)])
      current = result.content
    }
    return current
  }

  /**
   * Run agents in parallel — all receive the same input, results merged.
   */
  static async parallel(
    agents: ForgeAgent[],
    input: string,
    merge?: MergeFn,
  ): Promise<string> {
    const results = await Promise.all(
      agents.map(agent => agent.generate([new HumanMessage(input)])),
    )
    const contents = results.map(r => r.content)
    return (merge ?? defaultMerge)(contents)
  }

  /**
   * Supervisor pattern — manager agent delegates to specialist agents via tools.
   *
   * Each specialist is exposed as a tool. The manager decides which specialist
   * to invoke and with what input via LLM function calling.
   */
  static async supervisor(
    manager: ForgeAgent,
    specialists: ForgeAgent[],
    task: string,
  ): Promise<string> {
    // Wrap each specialist as a tool for the manager
    // TODO: wire specialist tools into manager agent
    void await Promise.all(
      specialists.map(s => s.asTool()),
    )

    // Create a manager instance with specialist tools added
    // Since ForgeAgent is immutable after construction, we create new messages
    // that describe the available specialists
    const specialistDesc = specialists
      .map(s => `- agent-${s.id}: ${s.description}`)
      .join('\n')

    const messages: BaseMessage[] = [
      new HumanMessage(
        `${task}\n\nYou have access to these specialist agents:\n${specialistDesc}\n\n` +
        `Use the appropriate agent tool(s) to complete this task.`,
      ),
    ]

    // Note: In production, the manager would be constructed with these tools.
    // This is a simplified version that just generates with the specialist info.
    const result = await manager.generate(messages)
    return result.content
  }

  /**
   * Debate pattern — multiple agents propose solutions, a judge selects the best.
   */
  static async debate(
    proposers: ForgeAgent[],
    judge: ForgeAgent,
    task: string,
    options?: { rounds?: number },
  ): Promise<string> {
    const rounds = options?.rounds ?? 1
    let proposals: string[] = []

    for (let round = 0; round < rounds; round++) {
      // Each proposer generates a solution
      const roundInput = round === 0
        ? task
        : `${task}\n\nPrevious proposals:\n${proposals.map((p, i) => `Proposal ${i + 1}: ${p}`).join('\n\n')}\n\nImprove upon the best aspects of all proposals.`

      const results = await Promise.all(
        proposers.map(agent => agent.generate([new HumanMessage(roundInput)])),
      )
      proposals = results.map(r => r.content)
    }

    // Judge selects the best
    const judgeInput = proposals
      .map((p, i) => `## Proposal ${i + 1}\n${p}`)
      .join('\n\n')

    const judgeResult = await judge.generate([
      new HumanMessage(
        `Evaluate these proposals for the following task:\n\n**Task:** ${task}\n\n${judgeInput}\n\n` +
        `Select the best proposal (or synthesize the best parts of multiple proposals). ` +
        `Explain your reasoning briefly, then provide the final answer.`,
      ),
    ])

    return judgeResult.content
  }
}
