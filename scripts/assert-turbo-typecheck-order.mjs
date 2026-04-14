import { readFileSync } from 'node:fs'

const turboConfigPath = new URL('../turbo.json', import.meta.url)
const turboConfigText = readFileSync(turboConfigPath, 'utf8')
const turboConfig = JSON.parse(turboConfigText)

const typecheckDependsOn = turboConfig?.tasks?.typecheck?.dependsOn

if (!Array.isArray(typecheckDependsOn)) {
  throw new Error('turbo.tasks.typecheck.dependsOn must be an array')
}

if (!typecheckDependsOn.includes('^build')) {
  throw new Error('Expected turbo.tasks.typecheck.dependsOn to include "^build"')
}

console.log('OK: turbo typecheck depends on ^build')