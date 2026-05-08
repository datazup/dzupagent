import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function listWorkspacePackageDirs(root) {
  const packagesRoot = path.join(root, 'packages');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packageDirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const packageDir = path.join('packages', entry.name);
    if (await fileExists(path.join(root, packageDir, 'package.json'))) {
      packageDirs.push(packageDir);
    }
  }

  return packageDirs.sort();
}

function collectExportTargets(exportValue, conditionPath = []) {
  if (typeof exportValue === 'string') {
    return [{ condition: conditionPath.join('.') || 'default', target: exportValue }];
  }

  if (!exportValue || typeof exportValue !== 'object' || Array.isArray(exportValue)) {
    return [];
  }

  const targets = [];
  for (const [condition, value] of Object.entries(exportValue)) {
    if (typeof value === 'string') {
      targets.push({
        condition: [...conditionPath, condition].join('.'),
        target: value,
      });
      continue;
    }

    targets.push(...collectExportTargets(value, [...conditionPath, condition]));
  }

  return targets;
}

function validateRelativeTarget({ packageName, packageDir, label, target, messages }) {
  if (!target.startsWith('./')) {
    messages.push(`${packageName} ${label} target must be package-relative, got ${target}`);
    return undefined;
  }

  return path.join(packageDir, target.slice(2));
}

async function checkPackage({ root, packageDir }) {
  const packageJsonPath = path.join(root, packageDir, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const packageName = packageJson.name ?? packageDir;
  const messages = [];

  if (typeof packageJson.types === 'string') {
    const relativeTypesPath = validateRelativeTarget({
      packageName,
      packageDir,
      label: 'package types',
      target: packageJson.types.startsWith('./') ? packageJson.types : `./${packageJson.types}`,
      messages,
    });

    if (relativeTypesPath && !(await fileExists(path.join(root, relativeTypesPath)))) {
      messages.push(`${packageName} package types target is missing: ${relativeTypesPath}`);
    }
  }

  const packageExports = packageJson.exports;
  if (!packageExports || typeof packageExports !== 'object' || Array.isArray(packageExports)) {
    return messages;
  }

  for (const [subpath, exportValue] of Object.entries(packageExports)) {
    const targets = collectExportTargets(exportValue);
    const typeTargets = targets.filter(({ condition }) => condition.split('.').includes('types'));
    const runtimeTargets = targets.filter(({ condition }) => {
      const parts = condition.split('.');
      return parts.includes('import') || parts.includes('require') || parts.includes('default');
    });

    if (typeTargets.length === 0) {
      messages.push(`${packageName} ${subpath} export has no types target`);
    }

    if (runtimeTargets.length === 0) {
      messages.push(`${packageName} ${subpath} export has no runtime import/require/default target`);
    }

    for (const { condition, target } of targets) {
      const relativeTargetPath = validateRelativeTarget({
        packageName,
        packageDir,
        label: `${subpath} ${condition}`,
        target,
        messages,
      });

      if (relativeTargetPath && !(await fileExists(path.join(root, relativeTargetPath)))) {
        messages.push(`${packageName} ${subpath} ${condition} target is missing: ${relativeTargetPath}`);
      }
    }
  }

  return messages;
}

export async function checkPackageExportArtifacts({ root = process.cwd(), packageDirs } = {}) {
  const selectedPackageDirs = packageDirs?.length ? packageDirs : await listWorkspacePackageDirs(root);
  const messages = [];

  for (const packageDir of selectedPackageDirs) {
    messages.push(...await checkPackage({ root, packageDir }));
  }

  return {
    ok: messages.length === 0,
    messages,
    packageDirs: selectedPackageDirs,
  };
}

async function main() {
  const packageDirs = process.argv.slice(2);
  const result = await checkPackageExportArtifacts({ packageDirs });

  if (!result.ok) {
    for (const message of result.messages) {
      console.error(`package-export-artifacts: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`package-export-artifacts: ok (${result.packageDirs.length} packages)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
