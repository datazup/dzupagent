#!/usr/bin/env node
/**
 * portal-closure.mjs
 *
 * The dzupagent graph's consumer contract, derived from the graph itself.
 *
 * Why this exists
 * ---------------
 * Every intra-scope dependency in packages/*\/package.json is an exact version
 * ("0.2.0", never "workspace:"). That is correct for a publishable monorepo, and
 * inside this repo Yarn's transparent workspaces satisfy those ranges locally.
 * But the @dzupagent scope is not published anywhere, so application
 * repositories consume these packages through `portal:` resolutions — and a
 * portal's dependencies are resolved by the CONSUMER project. Every consumer
 * must therefore list the whole transitive @dzupagent closure of the packages
 * it portals, or `yarn install` dies on `@dzupagent/<leaf>@npm:<version>` with
 * a registry 404.
 *
 * Nothing derived that closure. On 2026-09-03 (bb90bdce, ARCH27-T-13) the
 * canonical-json mirror was renamed from @datazup/ to @dzupagent/, adding one
 * node under runtime-contracts, flow-dsl, flow-compiler and agent-adapters.
 * Eleven application repositories then broke one at a time, and eleven
 * separate sessions each hand-added the identical line
 *
 *   "@dzupagent/canonical-json": "portal:../../dzupagent/packages/canonical-json"
 *
 * treating it as that repository's own install bug. This script makes the
 * closure a derived, checkable fact so the next rename or new leaf is reported
 * by name — with the exact line that resolves it — instead of discovered
 * eleven times.
 *
 * Two facts the report states explicitly, because both were misread:
 *
 *   - A `private: true` leaf (canonical-json is the only one) can never be
 *     supplied by any registry. The portal is its only source, so `yarn up -R`
 *     or a version bump cannot help. The report labels these.
 *   - `link:` roots are opaque by Yarn's semantics (no dependency resolution
 *     happens through a link), and `file:` tarball roots carry their own
 *     manifests packed by the worker-package-set generator. Only `portal:`
 *     roots need the closure, and only those are walked.
 *
 * Modes
 * -----
 *   node scripts/portal-closure.mjs
 *       Validate the graph: every @dzupagent/* declaration in packages/* must
 *       name a workspace package at its exact version, using no path protocol.
 *       This is the `check:portal-closure` gate. Exit 1 on any problem.
 *
 *   node scripts/portal-closure.mjs --root @dzupagent/runtime-contracts [--root ...]
 *       Print the transitive closure of the given roots.
 *
 *   node scripts/portal-closure.mjs --consumer <path/to/package.json> [...]
 *   node scripts/portal-closure.mjs --apps <dir>
 *       Audit consumer manifests (or every <dir>/*\/package.json that portals
 *       this scope). Reports each closure member with no resolution, its `via`
 *       chain, and the portal line that resolves it. Exit 1 if anything is
 *       missing or stale.
 *
 *   --write   Append the missing resolutions to each consumer manifest.
 *   --check   Never write (the default; spelled out for readability in gates).
 *   --json    Machine-readable report.
 *   --repo    Override the dzupagent root (default: this script's repository).
 *
 * No dependencies beyond node:*.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SCOPE = '@dzupagent/';
export const HARD_FIELDS = ['dependencies', 'optionalDependencies'];
export const PEER_FIELD = 'peerDependencies';
const PATH_PROTOCOL = /^(?:workspace|portal|link|file|patch):/u;
const SCOPED_KEY = /^(@dzupagent\/[^/@]+)(?:@.*)?$/u;

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Derive the intra-scope graph from packages/*\/package.json.
 *
 * Edges follow dependencies and optionalDependencies (hard: Yarn must resolve
 * them) and non-optional peerDependencies (Yarn does not fetch a peer, but a
 * portal consumer must still provide it or the import fails at runtime).
 * devDependencies are ignored: portals never install them.
 *
 * Problems are the graph-level invariant this script gates:
 *   DANGLING          — an @dzupagent/* dependency that is not a workspace package
 *   VERSION_MISMATCH  — declared range differs from the workspace package version
 *   PATH_PROTOCOL     — workspace:/portal:/link:/file: inside a manifest that
 *                       portal consumers cannot resolve relative to themselves
 */
export function readWorkspaceGraph(repoRoot = DEFAULT_REPO_ROOT) {
  const packagesDir = path.join(repoRoot, 'packages');
  const packages = new Map();
  const problems = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(packagesDir, entry.name);
    const manifestPath = path.join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(SCOPE)) continue;
    const peerMeta = manifest.peerDependenciesMeta ?? {};
    const edges = [];
    for (const field of HARD_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!name.startsWith(SCOPE)) continue;
        edges.push({ name, range, kind: field === 'dependencies' ? 'dependency' : 'optional' });
      }
    }
    for (const [name, range] of Object.entries(manifest[PEER_FIELD] ?? {})) {
      if (!name.startsWith(SCOPE)) continue;
      if (peerMeta[name]?.optional === true) continue;
      edges.push({ name, range, kind: 'peer' });
    }
    packages.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      private: manifest.private === true,
      directory,
      relativeDirectory: `packages/${entry.name}`,
      edges,
    });
  }

  for (const pkg of packages.values()) {
    for (const edge of pkg.edges) {
      const target = packages.get(edge.name);
      if (!target) {
        problems.push({
          code: 'DANGLING',
          package: pkg.name,
          dependency: edge.name,
          range: edge.range,
          message: `${pkg.name} depends on ${edge.name}@${edge.range}, which is not a workspace package — no consumer, and no registry, can resolve it`,
        });
        continue;
      }
      if (PATH_PROTOCOL.test(String(edge.range))) {
        problems.push({
          code: 'PATH_PROTOCOL',
          package: pkg.name,
          dependency: edge.name,
          range: edge.range,
          message: `${pkg.name} declares ${edge.name} as "${edge.range}"; a portal consumer resolves that path relative to itself, not to this package — use the exact version ${target.version}`,
        });
        continue;
      }
      if (edge.range !== target.version) {
        problems.push({
          code: 'VERSION_MISMATCH',
          package: pkg.name,
          dependency: edge.name,
          range: edge.range,
          message: `${pkg.name} depends on ${edge.name}@${edge.range} but the workspace package is ${target.version} — transparent workspaces will not satisfy it and the registry has no such version`,
        });
      }
    }
  }

  return { repoRoot, packages, problems };
}

/**
 * Transitive closure of `roots` over the graph, breadth-first, deterministic.
 * Each member carries the first `via` chain that reached it (root first).
 * Unknown roots are returned with `known: false` and not expanded.
 */
export function closureOf(graph, roots) {
  const members = new Map();
  const queue = [];
  for (const root of [...new Set(roots)].sort()) {
    const pkg = graph.packages.get(root);
    if (!pkg) {
      members.set(root, { name: root, known: false, via: [root] });
      continue;
    }
    members.set(root, {
      name: root,
      known: true,
      version: pkg.version,
      private: pkg.private,
      relativeDirectory: pkg.relativeDirectory,
      via: [root],
      kind: 'root',
    });
    queue.push(root);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    const pkg = graph.packages.get(current);
    const chain = members.get(current).via;
    for (const edge of [...pkg.edges].sort((a, b) => a.name.localeCompare(b.name))) {
      if (members.has(edge.name)) continue;
      const target = graph.packages.get(edge.name);
      if (!target) {
        members.set(edge.name, { name: edge.name, known: false, via: [...chain, edge.name], kind: edge.kind });
        continue;
      }
      members.set(edge.name, {
        name: edge.name,
        known: true,
        version: target.version,
        private: target.private,
        relativeDirectory: target.relativeDirectory,
        via: [...chain, edge.name],
        kind: edge.kind,
      });
      queue.push(edge.name);
    }
  }
  return [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function descriptorKind(descriptor) {
  if (typeof descriptor !== 'string') return 'other';
  const match = /^(portal|link|file|workspace):/u.exec(descriptor);
  return match ? match[1] : 'other';
}

/**
 * Collect the @dzupagent/* entries a consumer manifest declares, from
 * dependencies, devDependencies and resolutions. Nested resolution keys such
 * as "@dzupagent/core/undici" pin a transitive dependency of a package, not the
 * package itself, and are ignored; "name@range" keys are normalised to name.
 */
export function consumerDeclarations(manifest) {
  const declared = new Map();
  for (const field of ['dependencies', 'devDependencies', 'resolutions']) {
    for (const [key, descriptor] of Object.entries(manifest[field] ?? {})) {
      const match = SCOPED_KEY.exec(key);
      if (!match) continue;
      const name = match[1];
      const prior = declared.get(name);
      const kind = descriptorKind(descriptor);
      // A path-protocol declaration wins over a bare range for classification:
      // it is what Yarn will actually resolve the ident to.
      if (!prior || (prior.kind === 'other' && kind !== 'other')) {
        declared.set(name, { name, descriptor, kind, field });
      }
    }
  }
  return declared;
}

/**
 * The directory the consumer's existing portal roots point into, as written
 * in the manifest (e.g. "../../dzupagent/packages"). Suggested lines reuse it
 * so `--write` emits exactly the form the consumer already uses, whichever
 * checkout this script happens to run from.
 */
export function portalBase(declared, consumerDir, graph) {
  for (const entry of [...declared.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== 'portal') continue;
    const target = entry.descriptor.slice('portal:'.length);
    const pkg = graph.packages.get(entry.name);
    const suffix = pkg ? `/${path.basename(pkg.relativeDirectory)}` : null;
    if (suffix && target.endsWith(suffix)) {
      return target.slice(0, -suffix.length);
    }
  }
  const fallback = path.relative(consumerDir, path.join(graph.repoRoot, 'packages'));
  return toPosix(fallback);
}

/**
 * Audit one consumer manifest against the graph.
 */
export function auditConsumer(graph, consumerManifestPath) {
  const manifestPath = path.resolve(consumerManifestPath);
  const consumerDir = path.dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const declared = consumerDeclarations(manifest);

  const roots = { portal: [], link: [], file: [], other: [] };
  const stale = [];
  for (const entry of declared.values()) {
    const bucket = roots[entry.kind] ?? roots.other;
    bucket.push(entry.name);
    if (entry.kind !== 'portal') continue;
    const target = path.resolve(consumerDir, entry.descriptor.slice('portal:'.length));
    const targetManifest = path.join(target, 'package.json');
    if (!existsSync(targetManifest)) {
      stale.push({ name: entry.name, descriptor: entry.descriptor, reason: `portal target has no package.json: ${target}` });
      continue;
    }
    let targetName;
    try {
      targetName = readJson(targetManifest).name;
    } catch (error) {
      stale.push({ name: entry.name, descriptor: entry.descriptor, reason: `portal target manifest unreadable: ${error.message}` });
      continue;
    }
    if (targetName !== entry.name) {
      stale.push({ name: entry.name, descriptor: entry.descriptor, reason: `portal target is ${targetName}, not ${entry.name}` });
    }
  }
  for (const bucket of Object.values(roots)) bucket.sort();

  const closure = closureOf(graph, roots.portal);
  const base = portalBase(declared, consumerDir, graph);
  const missing = [];
  for (const member of closure) {
    if (declared.has(member.name)) continue;
    if (!member.known) {
      // A dangling edge is a graph problem, reported by readWorkspaceGraph; a
      // consumer cannot resolve it either way.
      missing.push({ ...member, resolution: null });
      continue;
    }
    missing.push({
      ...member,
      resolution: `portal:${base}/${path.basename(member.relativeDirectory)}`,
    });
  }

  return {
    consumer: manifestPath,
    roots,
    declared: [...declared.keys()].sort(),
    closure,
    missing,
    stale,
    ok: missing.length === 0 && stale.length === 0,
  };
}

/**
 * Append the missing resolutions to the consumer manifest, preserving its key
 * order and indentation. Returns the names written.
 */
export function writeMissing(audit) {
  const writable = audit.missing.filter((m) => m.resolution);
  if (writable.length === 0) return [];
  const text = readFileSync(audit.consumer, 'utf8');
  const manifest = JSON.parse(text);
  const indentMatch = /\n([ \t]+)"/u.exec(text);
  const indent = indentMatch ? indentMatch[1] : '  ';
  manifest.resolutions = manifest.resolutions ?? {};
  for (const member of writable) {
    manifest.resolutions[member.name] = member.resolution;
  }
  writeFileSync(audit.consumer, `${JSON.stringify(manifest, null, indent)}\n`);
  return writable.map((m) => m.name);
}

/** Every <dir>/*\/package.json that declares at least one @dzupagent/* entry. */
export function discoverConsumers(appsDir) {
  const consumers = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(appsDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch {
      continue;
    }
    if (consumerDeclarations(manifest).size === 0) continue;
    consumers.push(manifestPath);
  }
  return consumers;
}

export function parseArgs(argv) {
  const options = { roots: [], consumers: [], apps: null, write: false, check: false, json: false, repo: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--root': options.roots.push(next()); break;
      case '--consumer': options.consumers.push(next()); break;
      case '--apps': options.apps = next(); break;
      case '--repo': options.repo = next(); break;
      case '--write': options.write = true; break;
      case '--check': options.check = true; break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.write && options.check) throw new Error('--write and --check are mutually exclusive');
  return options;
}

function describeMember(member) {
  const label = member.known ? `${member.name}@${member.version}` : `${member.name} (NOT a workspace package)`;
  const leaf = member.private ? ' — private leaf: no registry can supply it, the portal is its only source' : '';
  return `${label}${leaf}`;
}

export function formatReport(report) {
  const lines = [];
  const { graph } = report;
  lines.push(`portal-closure: graph ${graph.packageCount} packages, ${graph.problems.length} problem${graph.problems.length === 1 ? '' : 's'}`);
  for (const problem of graph.problems) lines.push(`  - [${problem.code}] ${problem.message}`);
  for (const closure of report.closures ?? []) {
    lines.push(`closure of ${closure.roots.join(', ')}: ${closure.members.length} packages`);
    for (const member of closure.members) {
      lines.push(`  - ${describeMember(member)}  via ${member.via.join(' -> ')}`);
    }
  }
  for (const audit of report.consumers ?? []) {
    const rel = toPosix(path.relative(process.cwd(), audit.consumer)) || audit.consumer;
    lines.push(
      `${rel}: ${audit.roots.portal.length} portal root${audit.roots.portal.length === 1 ? '' : 's'}` +
        (audit.roots.link.length ? `, ${audit.roots.link.length} link (opaque)` : '') +
        (audit.roots.file.length ? `, ${audit.roots.file.length} file (vendored)` : '') +
        `, closure ${audit.closure.length}, missing ${audit.missing.length}, stale ${audit.stale.length}` +
        (audit.written?.length ? `, wrote ${audit.written.length}` : ''),
    );
    for (const member of audit.missing) {
      lines.push(`  - missing ${describeMember(member)}`);
      lines.push(`      via ${member.via.join(' -> ')}`);
      if (member.resolution) lines.push(`      add: "${member.name}": "${member.resolution}"`);
    }
    for (const entry of audit.stale) {
      lines.push(`  - stale ${entry.name} = "${entry.descriptor}": ${entry.reason}`);
    }
  }
  return lines.join('\n');
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    return { exitCode: 0, output: readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n/u, '').replace(/^ \* ?/gmu, '') };
  }
  const repoRoot = options.repo ? path.resolve(cwd, options.repo) : DEFAULT_REPO_ROOT;
  const graph = readWorkspaceGraph(repoRoot);
  const report = {
    graph: { repoRoot, packageCount: graph.packages.size, problems: graph.problems },
    closures: [],
    consumers: [],
  };
  let failed = graph.problems.length > 0;

  if (options.roots.length > 0) {
    report.closures.push({ roots: options.roots, members: closureOf(graph, options.roots) });
  }

  const consumerPaths = options.consumers.map((c) => path.resolve(cwd, c));
  if (options.apps) consumerPaths.push(...discoverConsumers(path.resolve(cwd, options.apps)));
  for (const consumerPath of consumerPaths) {
    const audit = auditConsumer(graph, consumerPath);
    if (options.write && audit.missing.length > 0) {
      audit.written = writeMissing(audit);
      const after = auditConsumer(graph, consumerPath);
      audit.missing = after.missing;
      audit.ok = after.ok;
    }
    if (!audit.ok) failed = true;
    report.consumers.push(audit);
  }

  const output = options.json ? JSON.stringify(report, null, 2) : formatReport(report);
  return { exitCode: failed ? 1 : 0, output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = run(process.argv.slice(2));
  } catch (error) {
    console.error(`portal-closure: ${error.message}`);
    process.exit(2);
  }
  (result.exitCode === 0 ? console.log : console.error)(result.output);
  process.exit(result.exitCode);
}
