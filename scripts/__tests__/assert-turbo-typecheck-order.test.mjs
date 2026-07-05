import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkTurboTypecheckOrder } from '../assert-turbo-typecheck-order.mjs';

test('requires root typecheck to depend on upstream builds', () => {
  const result = checkTurboTypecheckOrder({
    tasks: {
      typecheck: { dependsOn: ['^typecheck'] },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /typecheck\.dependsOn.*"\^build"/);
});

test('requires agent-adapters typecheck to build its declaration-producing dependencies first', () => {
  const result = checkTurboTypecheckOrder({
    tasks: {
      typecheck: { dependsOn: ['^build', '^typecheck'] },
      '@dzupagent/agent-adapters#typecheck': {
        dependsOn: ['^build'],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(
    result.messages.join('\n'),
    /@dzupagent\/agent-adapters#typecheck.*@dzupagent\/subagents#build/,
  );
});

test('passes when agent-adapters typecheck has explicit dependency build edges', () => {
  const dependencyBuilds = [
    '@dzupagent/adapter-rules#build',
    '@dzupagent/adapter-types#build',
    '@dzupagent/agent#build',
    '@dzupagent/agent-types#build',
    '@dzupagent/core#build',
    '@dzupagent/runtime-contracts#build',
    '@dzupagent/security#build',
    '@dzupagent/subagents#build',
  ];

  const result = checkTurboTypecheckOrder({
    tasks: {
      typecheck: { dependsOn: ['^build', '^typecheck'] },
      '@dzupagent/agent-adapters#typecheck': {
        dependsOn: ['^build', ...dependencyBuilds],
      },
    },
  });

  assert.equal(result.ok, true, result.messages.join('\n'));
});
