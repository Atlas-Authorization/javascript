// Prints the emulator coverage of every OpenAPI operation as JSON, for scripts/surface-matrix.mjs:
//   node packages/emulator-core/scripts/emulator-coverage.mjs <openapi.json> > emulator-coverage.json
// Output: { operations: { "GET /v1/users": "handler" | "generic", ... }, extra: ["POST /oauth2/token", ...] }
// Needs the package built (`pnpm --filter @atlasauth/emulator-core build`).
import { readFileSync } from 'node:fs';
import { createEmulatorEngine, coverageList } from '../dist/index.js';

const file = process.argv[2];
if (!file) throw new Error('usage: emulator-coverage.mjs <openapi.json>');
const engine = createEmulatorEngine({ openapi: JSON.parse(readFileSync(file, 'utf8')) });
process.stdout.write(`${JSON.stringify(coverageList(engine), null, 2)}\n`);
await engine.close();
