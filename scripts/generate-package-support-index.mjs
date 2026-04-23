import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..');
const manifestPath = path.join(repoRoot, 'config', 'package-tiers.json');
const packagesDir = path.join(repoRoot, 'packages');
const outputPath = path.join(repoRoot, 'docs', 'PACKAGE_SUPPORT_INDEX.md');

export function readPackageSupportEntries(options = {}) {
  const effectiveRepoRoot = options.repoRoot ?? repoRoot;
  const effectiveManifestPath = path.join(effectiveRepoRoot, 'config', 'package-tiers.json');
  const effectivePackagesDir = path.join(effectiveRepoRoot, 'packages');
  const manifest = JSON.parse(fs.readFileSync(effectiveManifestPath, 'utf8'));

  return fs.readdirSync(effectivePackagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(effectivePackagesDir, entry.name, 'package.json')))
    .map((entry) => {
      const packageDir = path.join(effectivePackagesDir, entry.name);
      const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      const tierEntry = manifest[packageJson.name] ?? null;
      return {
        dirName: entry.name,
        name: packageJson.name,
        tier: tierEntry?.tier ?? 'unmapped',
        status: tierEntry?.status ?? 'unmapped',
        roadmapDriver: tierEntry?.roadmapDriver ?? false,
        owners: Array.isArray(tierEntry?.owners) ? tierEntry.owners : []
      };
    })
    .sort((left, right) => {
      if (left.tier === right.tier) return left.name.localeCompare(right.name);
      return Number(left.tier) - Number(right.tier);
    });
}

export function buildPackageSupportIndex({ generatedOn, packageEntries }) {
  const lines = [
    '# Package Support Index',
    '',
    `Date: ${generatedOn}`,
    '',
    'This document is generated from `config/package-tiers.json` and the package inventory under `packages/*`.',
    '',
    '| Package | Path | Tier | Status | Roadmap Driver | Owners |',
    '| --- | --- | --- | --- | --- | --- |'
  ];

  for (const entry of packageEntries) {
    lines.push(
      `| \`${entry.name}\` | \`packages/${entry.dirName}\` | \`${entry.tier}\` | \`${entry.status}\` | \`${entry.roadmapDriver}\` | ${entry.owners.length > 0 ? entry.owners.map((owner) => `\`${owner}\``).join(', ') : '—'} |`
    );
  }

  lines.push('');
  lines.push('Regenerate this file with `yarn docs:package-support-index`.');
  return `${lines.join('\n')}\n`;
}

export function generatePackageSupportIndex(options = {}) {
  const effectiveRepoRoot = options.repoRoot ?? repoRoot;
  const effectiveOutputPath = options.outputPath ?? path.join(effectiveRepoRoot, 'docs', 'PACKAGE_SUPPORT_INDEX.md');
  const generatedOn = options.generatedOn ?? new Date().toISOString().slice(0, 10);
  const packageEntries = options.packageEntries ?? readPackageSupportEntries({ repoRoot: effectiveRepoRoot });
  const content = buildPackageSupportIndex({ generatedOn, packageEntries });
  fs.writeFileSync(effectiveOutputPath, content);
  return { generatedOn, packageEntries, content, outputPath: effectiveOutputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generatePackageSupportIndex({ repoRoot, outputPath, packageEntries: readPackageSupportEntries({ repoRoot }) });
}
