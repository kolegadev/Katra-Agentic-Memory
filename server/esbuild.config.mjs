// esbuild config — transpiles all TypeScript files individually.
// Used instead of tsc because tsc OOMs on Pi 5 (8GB RAM) with large projects.
// esbuild transpiles individual files in milliseconds.

import { build } from 'esbuild';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

function getAllTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...getAllTsFiles(path));
    } else if (entry.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

const srcDir = 'src';
const outDir = 'build';
const tsFiles = getAllTsFiles(srcDir);

console.log(`🔨 Building ${tsFiles.length} TypeScript files with esbuild...`);

await build({
  entryPoints: tsFiles,
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
}).then(() => {
  console.log(`✅ Build complete: ${tsFiles.length} files → ${outDir}/`);
}).catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
