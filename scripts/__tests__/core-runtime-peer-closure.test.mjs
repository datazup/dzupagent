import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { subset } from 'semver';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function readPackageJson(packageJsonPath) {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
}

test('core provides the required peers of its PostgreSQL checkpoint dependency', () => {
  const corePackageJsonPath = path.join(repoRoot, 'packages/core/package.json');
  const core = readPackageJson(corePackageJsonPath);
  const coreRequire = createRequire(corePackageJsonPath);
  const postgresPackageJsonPath = coreRequire.resolve(
    '@langchain/langgraph-checkpoint-postgres/package.json',
  );
  const postgres = readPackageJson(postgresPackageJsonPath);
  const provided = {
    ...core.dependencies,
    ...core.peerDependencies,
  };

  function assertRequiredPeerClosure(packageJsonPath, packageJson, seen) {
    const packageRequire = createRequire(packageJsonPath);

    for (const [peer, range] of Object.entries(
      packageJson.peerDependencies ?? {},
    )) {
      const optional = packageJson.peerDependenciesMeta?.[peer]?.optional === true;
      if (optional) continue;

      assert.ok(
        provided[peer],
        `@dzupagent/core must provide ${peer}@${range}, required by ${packageJson.name}`,
      );
      assert.equal(
        subset(provided[peer], range),
        true,
        `@dzupagent/core range ${provided[peer]} must be contained by ${packageJson.name}'s required ${peer} range ${range}`,
      );

      if (!core.dependencies?.[peer] || seen.has(peer)) continue;
      seen.add(peer);
      const peerPackageJsonPath = packageRequire.resolve(`${peer}/package.json`);
      assertRequiredPeerClosure(
        peerPackageJsonPath,
        readPackageJson(peerPackageJsonPath),
        seen,
      );
    }
  }

  assertRequiredPeerClosure(postgresPackageJsonPath, postgres, new Set());
});
