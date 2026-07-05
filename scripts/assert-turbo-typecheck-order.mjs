import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const turboConfigPath = new URL('../turbo.json', import.meta.url)
const AGENT_ADAPTERS_DEPENDENCY_BUILDS = [
  '@dzupagent/adapter-rules#build',
  '@dzupagent/adapter-types#build',
  '@dzupagent/agent#build',
  '@dzupagent/agent-types#build',
  '@dzupagent/core#build',
  '@dzupagent/runtime-contracts#build',
  '@dzupagent/security#build',
  '@dzupagent/subagents#build',
]

export function checkTurboTypecheckOrder(turboConfig) {
  const messages = []

  const typecheckDependsOn = turboConfig?.tasks?.typecheck?.dependsOn
  if (!Array.isArray(typecheckDependsOn)) {
    messages.push('turbo.tasks.typecheck.dependsOn must be an array')
  } else if (!typecheckDependsOn.includes('^build')) {
    messages.push('Expected turbo.tasks.typecheck.dependsOn to include "^build"')
  }

  const agentAdaptersTypecheck =
    turboConfig?.tasks?.['@dzupagent/agent-adapters#typecheck']?.dependsOn
  if (!Array.isArray(agentAdaptersTypecheck)) {
    messages.push(
      'turbo.tasks["@dzupagent/agent-adapters#typecheck"].dependsOn must be an array',
    )
  } else {
    for (const dependencyBuild of AGENT_ADAPTERS_DEPENDENCY_BUILDS) {
      if (!agentAdaptersTypecheck.includes(dependencyBuild)) {
        messages.push(
          `Expected @dzupagent/agent-adapters#typecheck dependsOn to include ${dependencyBuild}`,
        )
      }
    }
  }

  return {
    ok: messages.length === 0,
    messages,
  }
}

function main() {
  const turboConfigText = readFileSync(turboConfigPath, 'utf8')
  const turboConfig = JSON.parse(turboConfigText)
  const result = checkTurboTypecheckOrder(turboConfig)
  if (!result.ok) {
    throw new Error(result.messages.join('\n'))
  }
  console.log(
    'OK: turbo typecheck order builds upstream declaration artifacts before agent-adapters typecheck',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
