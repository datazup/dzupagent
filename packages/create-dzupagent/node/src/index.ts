// node — minimal DzupAgent project
import { DzupAgent } from '@dzupagent/agent'

const agent = new DzupAgent({
  name: 'node',
  instructions: 'You are a helpful assistant.',
})

console.log('Agent created:', agent.name)
