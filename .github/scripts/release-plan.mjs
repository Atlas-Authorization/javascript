// Lists the public @atlasauth packages to release: versions not on npm yet, and
// versions already published whose `latest` tag is still behind (a run that
// stopped between publish and the tag move). PCA packages (@atlasauth/pca*, create-pca-app)
// ship through their own lockstep release and are never published here.
// A version whose CHANGELOG.md does not describe it is held back (and fails the run
// at the end) without blocking the other packages.
import fs from 'node:fs';
import path from 'node:path';

const parts = (v) => v.split(/[.+-]/).slice(0, 3).map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const out = [];
const held = [];
for (const dir of fs.readdirSync('packages')) {
  const file = path.join('packages', dir, 'package.json');
  if (!fs.existsSync(file)) continue;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.private || !pkg.name || !pkg.version) continue;
  if (/^(@atlasauth\/pca($|-)|create-pca-app$)/.test(pkg.name)) continue;
  if (pkg.version.includes('-')) continue; // prereleases are tagged by hand
  const res = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}/latest`);
  if (res.status === 404) { out.push(pkg.name); continue; }
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${pkg.name}`);
  const { version: latest } = await res.json();
  if (newer(pkg.version, latest)) {
    // Integrators read CHANGELOG.md in the tarball: never publish a version it does not describe.
    const log = path.join('packages', dir, 'CHANGELOG.md');
    const heading = new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}\\b`, 'm');
    if (!fs.existsSync(log) || !heading.test(fs.readFileSync(log, 'utf8'))) {
      held.push(`${pkg.name}@${pkg.version}: CHANGELOG.md has no "## ${pkg.version}" heading`);
      continue;
    }
    out.push(pkg.name);
  }
}
for (const h of held) console.error(`::error::${h}`);
if (held.length) fs.writeFileSync('.release-held', held.join('\n') + '\n');
console.log(out.join(' '));
