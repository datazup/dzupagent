import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateBudgets } from '../measure-dts-build.mjs';

function makeResult(name, overrides = {}) {
  return {
    name,
    buildDurationMs: overrides.buildDurationMs,
    declarationInputSha256: overrides.declarationInputSha256,
    declarations: {
      declarationFileCount: overrides.declarationFileCount ?? 1,
      declarationBytes: overrides.declarationBytes ?? 100,
      declarationMapFileCount: overrides.declarationMapFileCount ?? 0,
      declarationMapBytes: overrides.declarationMapBytes ?? 0,
      declarationManifestSha256: overrides.declarationManifestSha256,
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

function declarationDebtPin(overrides = {}) {
  return {
    maxDeclarationFiles: 459,
    maxDeclarationBytes: 1_086_755,
    declarationManifestSha256: 'd'.repeat(64),
    declarationInputSha256: 'b'.repeat(64),
    sourceCommit: 'a'.repeat(40),
    reviewBy: '2026-09-30',
    approvedBy: 'Ninel Hodzic',
    approvedOn: '2026-08-30',
    rationale: 'Bind the exact reviewed declaration output while the lower caps remain enforced.',
    ...overrides,
  };
}

function declarationDebtConfig(pin = declarationDebtPin(), overrides = {}) {
  return {
    acceptedGrowthApprovers: ['Ninel Hodzic'],
    packages: {
      '@dzupagent/agent': {
        maxDeclarationFiles: 414,
        maxDeclarationBytes: 917_718,
        declarationDebtPin: pin,
      },
    },
    ...overrides,
  };
}

test('accepts an exact, source-bound and approved declaration debt pin above lower caps', () => {
  const result = evaluateBudgets(
    [makeResult('@dzupagent/agent', {
      declarationFileCount: 459,
      declarationBytes: 1_086_755,
      declarationManifestSha256: 'd'.repeat(64),
      declarationInputSha256: 'b'.repeat(64),
    })],
    declarationDebtConfig(),
    { now: new Date('2026-08-30T12:00:00.000Z') },
  );

  assert.equal(result.ok, true);
  assert.equal(result.debtPins.length, 1);
  assert.equal(result.debtPins[0].packageName, '@dzupagent/agent');
});

test('rejects declaration debt pins that leave headroom or drift from reviewed bytes', () => {
  const result = evaluateBudgets(
    [makeResult('@dzupagent/agent', {
      declarationFileCount: 459,
      declarationBytes: 1_086_755,
      declarationManifestSha256: 'x'.repeat(64),
      declarationInputSha256: 'b'.repeat(64),
    })],
    declarationDebtConfig(declarationDebtPin({ maxDeclarationFiles: 460 })),
    { now: new Date('2026-08-30T12:00:00.000Z') },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /zero slack/);
  assert.match(result.messages.join('\n'), /declaration manifest digest/);
});

test('rejects declaration debt pins without current authorized human review', () => {
  const unapproved = evaluateBudgets(
    [makeResult('@dzupagent/agent', {
      declarationFileCount: 459,
      declarationBytes: 1_086_755,
      declarationManifestSha256: 'd'.repeat(64),
      declarationInputSha256: 'b'.repeat(64),
    })],
    declarationDebtConfig(declarationDebtPin({ approvedBy: 'self-asserted-session' })),
    { now: new Date('2026-08-30T12:00:00.000Z') },
  );
  assert.equal(unapproved.ok, false);
  assert.match(unapproved.messages.join('\n'), /acceptedGrowthApprovers/);

  const expired = evaluateBudgets(
    [makeResult('@dzupagent/agent', {
      declarationFileCount: 459,
      declarationBytes: 1_086_755,
      declarationManifestSha256: 'd'.repeat(64),
      declarationInputSha256: 'b'.repeat(64),
    })],
    declarationDebtConfig(declarationDebtPin({ reviewBy: '2026-08-29' })),
    { now: new Date('2026-08-30T12:00:00.000Z') },
  );
  assert.equal(expired.ok, false);
  assert.match(expired.messages.join('\n'), /review expired/);
});

test('rejects calendar-invalid approval and review dates instead of normalizing them', () => {
  const result = evaluateBudgets(
    [makeResult('@dzupagent/agent', {
      declarationFileCount: 459,
      declarationBytes: 1_086_755,
      declarationManifestSha256: 'd'.repeat(64),
      declarationInputSha256: 'b'.repeat(64),
    })],
    declarationDebtConfig(declarationDebtPin({
      approvedOn: '2025-02-28',
      reviewBy: '2025-02-29',
    })),
    { now: new Date('2025-02-28T12:00:00.000Z') },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /reviewBy must be an ISO date/);
});
