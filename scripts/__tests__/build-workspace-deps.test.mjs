import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTurboBuildArgs,
  dependencyBuildOwnedByOuterTurbo,
} from '../build-workspace-deps.mjs';

test('standalone dependency builds retain the requested Turbo filters', () => {
  assert.deepEqual(buildTurboBuildArgs(['@dzupagent/core', '@dzupagent/memory']), [
    'turbo',
    'run',
    'build:verify',
    '--filter=@dzupagent/core',
    '--filter=@dzupagent/memory',
  ]);
});

test('only an active outer Turbo task owns dependency build ordering', () => {
  assert.equal(dependencyBuildOwnedByOuterTurbo({}), false);
  assert.equal(dependencyBuildOwnedByOuterTurbo({ TURBO_HASH: '' }), false);
  assert.equal(
    dependencyBuildOwnedByOuterTurbo({ TURBO_HASH: 'task-hash' }),
    true,
  );
});
