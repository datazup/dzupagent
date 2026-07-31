import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(resolved));
    else files.push(resolved);
  }
  return files;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

const packageRoot = path.resolve(process.argv[2] ?? '.');
const sourceRoot = path.join(packageRoot, 'src');
const declarationRoot = path.join(packageRoot, 'dist');
let strippedFiles = 0;
let strippedBytes = 0;

for (const declarationPath of await walk(declarationRoot)) {
  if (!declarationPath.endsWith('.d.ts')) continue;

  const relative = path.relative(declarationRoot, declarationPath);
  const sourcePath = path.join(sourceRoot, relative.replace(/\.d\.ts$/, '.ts'));
  if (!await isFile(sourcePath)) continue;

  const source = await readFile(sourcePath, 'utf8');
  const sourceModuleComment = source.match(
    /^(\/\*\*[\s\S]*?\*\/)(?=\s*import\b)/,
  )?.[1];
  if (!sourceModuleComment) continue;

  const declaration = await readFile(declarationPath, 'utf8');
  if (!declaration.startsWith(sourceModuleComment)) continue;

  const stripped = declaration.slice(sourceModuleComment.length).replace(/^\s*\n/, '');
  await writeFile(declarationPath, stripped);
  strippedFiles += 1;
  strippedBytes += declaration.length - stripped.length;
}

console.log(
  `declaration module comments: stripped ${strippedFiles} file(s), ${strippedBytes} byte(s)`,
);
