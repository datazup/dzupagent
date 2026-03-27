/**
 * Agent documentation renderer — produces markdown for a single agent definition.
 *
 * @module docs/agent-doc
 */

export interface AgentDocInput {
  name: string
  description: string
  tools?: string[]
  instructions?: string
  guardrails?: Record<string, unknown>
}

/**
 * Render a markdown document describing an agent.
 */
export function renderAgentDoc(agent: AgentDocInput): string {
  const lines: string[] = []

  lines.push(`# Agent: ${agent.name}`)
  lines.push('')
  lines.push(agent.description)
  lines.push('')

  if (agent.tools && agent.tools.length > 0) {
    lines.push('## Tools')
    lines.push('')
    for (const tool of agent.tools) {
      lines.push(`- \`${tool}\``)
    }
    lines.push('')
  }

  if (agent.instructions) {
    lines.push('## Instructions')
    lines.push('')
    lines.push(agent.instructions)
    lines.push('')
  }

  if (agent.guardrails && Object.keys(agent.guardrails).length > 0) {
    lines.push('## Guardrails')
    lines.push('')
    lines.push('| Setting | Value |')
    lines.push('|---------|-------|')
    for (const [key, value] of Object.entries(agent.guardrails)) {
      lines.push(`| ${key} | \`${JSON.stringify(value)}\` |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
