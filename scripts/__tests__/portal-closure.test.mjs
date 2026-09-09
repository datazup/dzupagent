import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  auditConsumer,
  closureOf,
  consumerDeclarations,
  discoverConsumers,
  parseArgs,
  portalBase,
  readWorkspaceGraph,
  run,
  writeMissing,
} from '../portal-closure.mjs';

const SCRIPT = fileURLToPath(new URL('../portal-closure.mjs', import.meta.url));
const REAL_REPO = path.resolve(path.dirname(SCRIPT), '..');

/**
 * A miniature dzupagent checkout beside a miniature app, laid out the way the
 * real workspace is (`<root>/dzupagent/packages/*` next to `<root>/apps/<app>`),
 * so the derived portal lines match the real ones byte for byte.
 */
function makeWorkspace({ packages, app }) {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-portal-closure-'));
  const repoRoot = path.join(root, 'dzupagent');
  for (const [dir, manifest] of Object.entries(packages)) {
    const packageDir = path.join(repoRoot, 'packages', dir);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  let consumer = null;
  if (app) {
    const appDir = path.join(root, 'apps', 'sample-app');
    mkdirSync(appDir, { recursive: true });
    consumer = path.join(appDir, 'package.json');
    writeFileSync(consumer, `${JSON.stringify(app, null, 2)}\n`);
  }
  return { root, repoRoot, consumer, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const BASE_PACKAGES = {
  core: { name: '@dzupagent/core', version: '0.2.0' },
  'canonical-json': { name: '@dzupagent/canonical-json', version: '0.1.0', private: true },
  'runtime-contracts': {
    name: '@dzupagent/runtime-contracts',
    version: '0.2.0',
    dependencies: { '@dzupagent/canonical-json': '0.1.0', zod: '^4.3.6' },
  },
  'flow-compiler': {
    name: '@dzupagent/flow-compiler',
    version: '0.2.0',
    dependencies: { '@dzupagent/runtime-contracts': '0.2.0' },
    peerDependencies: { '@dzupagent/core': '0.2.0' },
    devDependencies: { '@dzupagent/testing': '0.2.0' },
  },
  testing: { name: '@dzupagent/testing', version: '0.2.0' },
  'app-tools': {
    name: '@dzupagent/app-tools',
    version: '0.2.0',
    peerDependencies: { '@dzupagent/code-edit-kit': '0.2.0' },
    peerDependenciesMeta: { '@dzupagent/code-edit-kit': { optional: true } },
  },
  'code-edit-kit': { name: '@dzupagent/code-edit-kit', version: '0.2.0' },
};

test('the graph follows dependencies and required peers, never devDependencies or optional peers', () => {
  const ws = makeWorkspace({ packages: BASE_PACKAGES });
  try {
    const graph = readWorkspaceGraph(ws.repoRoot);
    assert.equal(graph.packages.size, 7);
    assert.deepEqual(graph.problems, []);

    const compiler = graph.packages.get('@dzupagent/flow-compiler');
    assert.deepEqual(
      compiler.edges.map((e) => [e.name, e.kind]),
      [
        ['@dzupagent/runtime-contracts', 'dependency'],
        ['@dzupagent/core', 'peer'],
      ],
      'devDependencies are not edges — portals do not install them',
    );
    assert.deepEqual(graph.packages.get('@dzupagent/app-tools').edges, [], 'an optional peer is not an edge');
    assert.equal(graph.packages.get('@dzupagent/canonical-json').private, true);
  } finally {
    ws.cleanup();
  }
});

test('the graph gate reports dangling, mismatched and path-protocol declarations', () => {
  const ws = makeWorkspace({
    packages: {
      ...BASE_PACKAGES,
      broken: {
        name: '@dzupagent/broken',
        version: '0.1.0',
        dependencies: {
          '@dzupagent/does-not-exist': '0.1.0',
          '@dzupagent/core': '0.3.0',
          '@dzupagent/testing': 'workspace:*',
        },
      },
    },
  });
  try {
    const graph = readWorkspaceGraph(ws.repoRoot);
    assert.deepEqual(
      graph.problems.map((p) => [p.code, p.dependency]),
      [
        ['DANGLING', '@dzupagent/does-not-exist'],
        ['VERSION_MISMATCH', '@dzupagent/core'],
        ['PATH_PROTOCOL', '@dzupagent/testing'],
      ],
    );
    const result = run(['--repo', ws.repoRoot]);
    assert.equal(result.exitCode, 1, 'the bare invocation is the gate and fails on graph problems');
    assert.match(result.output, /\[DANGLING\]/);
    assert.match(result.output, /\[VERSION_MISMATCH\]/);
    assert.match(result.output, /\[PATH_PROTOCOL\]/);
  } finally {
    ws.cleanup();
  }
});

test('closureOf is transitive, deterministic and records the first via chain', () => {
  const ws = makeWorkspace({ packages: BASE_PACKAGES });
  try {
    const graph = readWorkspaceGraph(ws.repoRoot);
    const closure = closureOf(graph, ['@dzupagent/flow-compiler']);
    assert.deepEqual(
      closure.map((m) => m.name),
      ['@dzupagent/canonical-json', '@dzupagent/core', '@dzupagent/flow-compiler', '@dzupagent/runtime-contracts'],
    );
    const leaf = closure.find((m) => m.name === '@dzupagent/canonical-json');
    assert.deepEqual(leaf.via, ['@dzupagent/flow-compiler', '@dzupagent/runtime-contracts', '@dzupagent/canonical-json']);
    assert.equal(leaf.private, true);
    assert.equal(leaf.kind, 'dependency');
    assert.equal(closure.find((m) => m.name === '@dzupagent/core').kind, 'peer');

    const unknown = closureOf(graph, ['@dzupagent/nope']);
    assert.deepEqual(unknown, [{ name: '@dzupagent/nope', known: false, via: ['@dzupagent/nope'] }]);
  } finally {
    ws.cleanup();
  }
});

test('consumer declarations ignore nested resolution keys and normalise name@range keys', () => {
  const declared = consumerDeclarations({
    dependencies: { '@dzupagent/core': 'portal:../../dzupagent/packages/core', express: '^5' },
    resolutions: {
      '@dzupagent/core/undici': '7.25.0',
      '@dzupagent/testing@npm:0.2.0': 'portal:../../dzupagent/packages/testing',
      '@dzupagent/agent': '0.2.0',
    },
  });
  assert.deepEqual([...declared.keys()].sort(), ['@dzupagent/agent', '@dzupagent/core', '@dzupagent/testing']);
  assert.equal(declared.get('@dzupagent/testing').kind, 'portal');
  assert.equal(declared.get('@dzupagent/agent').kind, 'other');
});

test('the regression: a portal consumer of runtime-contracts that omits the private leaf is reported with the exact line', () => {
  const ws = makeWorkspace({
    packages: BASE_PACKAGES,
    app: {
      name: 'sample-app',
      resolutions: {
        '@dzupagent/core': 'portal:../../dzupagent/packages/core',
        '@dzupagent/runtime-contracts': 'portal:../../dzupagent/packages/runtime-contracts',
      },
    },
  });
  try {
    const graph = readWorkspaceGraph(ws.repoRoot);
    const audit = auditConsumer(graph, ws.consumer);
    assert.deepEqual(audit.roots.portal, ['@dzupagent/core', '@dzupagent/runtime-contracts']);
    assert.equal(audit.ok, false);
    assert.equal(audit.missing.length, 1);
    const [missing] = audit.missing;
    assert.equal(missing.name, '@dzupagent/canonical-json');
    assert.equal(missing.private, true);
    assert.deepEqual(missing.via, ['@dzupagent/runtime-contracts', '@dzupagent/canonical-json']);
    assert.equal(missing.resolution, 'portal:../../dzupagent/packages/canonical-json');

    const result = run(['--repo', ws.repoRoot, '--consumer', ws.consumer]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /private leaf: no registry can supply it/);
    assert.match(
      result.output,
      /add: "@dzupagent\/canonical-json": "portal:\.\.\/\.\.\/dzupagent\/packages\/canonical-json"/,
    );
  } finally {
    ws.cleanup();
  }
});

test('--write appends exactly the missing lines, keeps order and indentation, and is idempotent', () => {
  const ws = makeWorkspace({
    packages: BASE_PACKAGES,
    app: {
      name: 'sample-app',
      dependencies: { express: '^5.0.0' },
      resolutions: {
        zod: '4.5.4',
        '@dzupagent/flow-compiler': 'portal:../../dzupagent/packages/flow-compiler',
      },
    },
  });
  try {
    const first = run(['--repo', ws.repoRoot, '--consumer', ws.consumer, '--write']);
    assert.equal(first.exitCode, 0, first.output);
    assert.deepEqual(first.report.consumers[0].written, [
      '@dzupagent/canonical-json',
      '@dzupagent/core',
      '@dzupagent/runtime-contracts',
    ]);
    const text = readFileSync(ws.consumer, 'utf8');
    const manifest = JSON.parse(text);
    assert.deepEqual(Object.keys(manifest.resolutions), [
      'zod',
      '@dzupagent/flow-compiler',
      '@dzupagent/canonical-json',
      '@dzupagent/core',
      '@dzupagent/runtime-contracts',
    ]);
    assert.equal(manifest.resolutions['@dzupagent/core'], 'portal:../../dzupagent/packages/core');
    assert.ok(text.endsWith('}\n'));
    assert.match(text, /\n  "resolutions": \{\n    "zod"/, 'two-space indentation preserved');

    const second = run(['--repo', ws.repoRoot, '--consumer', ws.consumer, '--check']);
    assert.equal(second.exitCode, 0, second.output);
    assert.equal(second.report.consumers[0].missing.length, 0);
    assert.equal(readFileSync(ws.consumer, 'utf8'), text, 'nothing rewritten on a complete consumer');
  } finally {
    ws.cleanup();
  }
});

test('link: roots are opaque, file: roots are vendored, and a stale portal target is reported', () => {
  const ws = makeWorkspace({
    packages: BASE_PACKAGES,
    app: {
      name: 'sample-app',
      resolutions: {
        '@dzupagent/flow-compiler': 'link:../../dzupagent/packages/flow-compiler',
        '@dzupagent/runtime-contracts': 'file:vendor/worker-package-sets/0.2.17/dependencies/dzupagent-runtime-contracts-0.2.0.tgz',
        '@dzupagent/testing': 'portal:../../dzupagent/packages/does-not-exist',
      },
    },
  });
  try {
    const graph = readWorkspaceGraph(ws.repoRoot);
    const audit = auditConsumer(graph, ws.consumer);
    assert.deepEqual(audit.roots.link, ['@dzupagent/flow-compiler']);
    assert.deepEqual(audit.roots.file, ['@dzupagent/runtime-contracts']);
    assert.deepEqual(audit.roots.portal, ['@dzupagent/testing']);
    assert.deepEqual(
      audit.missing,
      [],
      'neither the link nor the file root is walked: Yarn resolves nothing through a link, and a tarball carries its own manifest',
    );
    assert.equal(audit.stale.length, 1);
    assert.equal(audit.stale[0].name, '@dzupagent/testing');
    assert.match(audit.stale[0].reason, /no package\.json/);
    assert.equal(audit.ok, false);
  } finally {
    ws.cleanup();
  }
});

test('the portal base is derived from the consumer, so the suggestion never leaks the checkout the tool ran from', () => {
  const ws = makeWorkspace({
    packages: BASE_PACKAGES,
    app: {
      name: 'sample-app',
      resolutions: { '@dzupagent/runtime-contracts': 'portal:../../elsewhere/dzupagent-pin/packages/runtime-contracts' },
    },
  });
  try {
    const graph = readWorkspaceGraph(ws.repoRoot);
    const declared = consumerDeclarations(JSON.parse(readFileSync(ws.consumer, 'utf8')));
    assert.equal(portalBase(declared, path.dirname(ws.consumer), graph), '../../elsewhere/dzupagent-pin/packages');
    const audit = auditConsumer(graph, ws.consumer);
    assert.equal(audit.missing[0].resolution, 'portal:../../elsewhere/dzupagent-pin/packages/canonical-json');

    const noPortals = consumerDeclarations({ resolutions: { '@dzupagent/core': '0.2.0' } });
    assert.equal(
      portalBase(noPortals, path.dirname(ws.consumer), graph),
      '../../dzupagent/packages',
      'with no portal root to copy, fall back to the relative path to this graph',
    );
  } finally {
    ws.cleanup();
  }
});

test('--apps discovers only manifests that declare this scope', () => {
  const ws = makeWorkspace({ packages: BASE_PACKAGES, app: { name: 'sample-app', resolutions: { '@dzupagent/core': 'portal:../../dzupagent/packages/core' } } });
  try {
    const appsDir = path.join(ws.root, 'apps');
    mkdirSync(path.join(appsDir, 'plain-app'), { recursive: true });
    writeFileSync(path.join(appsDir, 'plain-app', 'package.json'), '{"name":"plain-app","dependencies":{"express":"^5"}}\n');
    mkdirSync(path.join(appsDir, 'not-json'), { recursive: true });
    writeFileSync(path.join(appsDir, 'not-json', 'package.json'), '{ nope');
    assert.deepEqual(discoverConsumers(appsDir), [ws.consumer]);
    const result = run(['--repo', ws.repoRoot, '--apps', appsDir, '--json']);
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(JSON.parse(result.output).consumers.length, 1);
  } finally {
    ws.cleanup();
  }
});

test('argument parsing rejects unknown flags and --write with --check', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--write', '--check']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--consumer']), /needs a value/);
  assert.deepEqual(parseArgs(['--root', 'a', '--root', 'b', '--json']).roots, ['a', 'b']);
});

test('the real graph: zero problems, and runtime-contracts closes over the private canonical-json leaf', () => {
  const graph = readWorkspaceGraph(REAL_REPO);
  assert.ok(graph.packages.size >= 30, `expected the real packages/* tree, saw ${graph.packages.size}`);
  assert.deepEqual(graph.problems, [], 'every intra-scope declaration names a workspace package at its exact version');

  const closure = closureOf(graph, ['@dzupagent/runtime-contracts']);
  const leaf = closure.find((m) => m.name === '@dzupagent/canonical-json');
  assert.ok(leaf, 'the ARCH27-T-13 mirror is in the closure of runtime-contracts — this is the node eleven consumers had to add by hand');
  assert.equal(leaf.private, true, 'and it is a private leaf, so no registry can ever supply it');

  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: REAL_REPO, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /0 problems/);
});
