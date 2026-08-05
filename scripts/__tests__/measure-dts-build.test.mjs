import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateBudgets } from '../measure-dts-build.mjs';

function makeResult(name, overrides = {}) {
  return {
    name,
    buildDurationMs: overrides.buildDurationMs,
    declarations: {
      declarationFileCount: overrides.declarationFileCount ?? 1,
      declarationBytes: overrides.declarationBytes ?? 100,
      declarationMapFileCount: overrides.declarationMapFileCount ?? 0,
      declarationMapBytes: overrides.declarationMapBytes ?? 0,
    },
  };
}

test('passes when measured declaration output stays within budget', () => {
  const result = evaluateBudgets(
    [makeResult('@dzupagent/codegen', { declarationFileCount: 10, declarationBytes: 2000 })],
    {
      packages: {
        '@dzupagent/codegen': {
          minDeclarationFiles: 1,
          minDeclarationBytes: 100,
          maxDeclarationFiles: 10,
          maxDeclarationBytes: 2000,
          maxDeclarationMapFiles: 0,
          maxDeclarationMapBytes: 0,
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, []);
});

test('fails when declaration maps return for a budgeted package', () => {
  const result = evaluateBudgets(
    [
      makeResult('@dzupagent/server', {
        declarationMapFileCount: 1,
        declarationMapBytes: 512,
      }),
    ],
    {
      packages: {
        '@dzupagent/server': {
          maxDeclarationMapFiles: 0,
          maxDeclarationMapBytes: 0,
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /@dzupagent\/server: maxDeclarationMapFiles exceeded/);
  assert.match(result.messages.join('\n'), /@dzupagent\/server: maxDeclarationMapBytes exceeded/);
});

test('fails when declaration artifacts disappear for a budgeted package', () => {
  const result = evaluateBudgets(
    [
      makeResult('@dzupagent/codegen', {
        declarationFileCount: 0,
        declarationBytes: 0,
      }),
    ],
    {
      packages: {
        '@dzupagent/codegen': {
          minDeclarationFiles: 1,
          minDeclarationBytes: 1,
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /@dzupagent\/codegen: minDeclarationFiles below minimum/);
  assert.match(result.messages.join('\n'), /@dzupagent\/codegen: minDeclarationBytes below minimum/);
});

test('points a minimum-floor breach at a rebuild, and does not misdirect an overage', () => {
  // A floor fires when dist holds JS but zero .d.ts. Without a cause named in the
  // message it reads as debt, and the plausible wrong fix -- lowering the floor --
  // disables the only check for a declaration-less publish. An overage is real
  // growth, so the same hint there would send the reader to a pointless rebuild.
  const floor = evaluateBudgets([makeResult('@dzupagent/codegen', { declarationFileCount: 0 })], {
    packages: { '@dzupagent/codegen': { minDeclarationFiles: 120 } },
  });

  assert.equal(floor.ok, false);
  assert.match(floor.messages.join('\n'), /stale or partial/);
  assert.match(floor.messages.join('\n'), /--filter=@dzupagent\/codegen --force/);

  const overage = evaluateBudgets([makeResult('@dzupagent/codegen', { declarationBytes: 999 })], {
    packages: { '@dzupagent/codegen': { maxDeclarationBytes: 1 } },
  });

  assert.equal(overage.ok, false);
  assert.doesNotMatch(overage.messages.join('\n'), /stale or partial/);
});

test('fails when a measured package has no configured budget', () => {
  const result = evaluateBudgets([makeResult('@dzupagent/agent')], { packages: {} });

  assert.equal(result.ok, false);
  assert.deepEqual(result.messages, ['@dzupagent/agent: no DTS budget configured']);
});
