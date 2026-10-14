import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read the package version from the shipped package.json at runtime rather than
 * importing it — `src/` is the tsc rootDir, so a static `import ../package.json`
 * would both break rootDir and bake a stale number into the bundle. At runtime
 * `__dirname` is `dist/`, so `../package.json` is the real manifest beside it.
 */
export function getVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
