import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

/** No credential in these contexts: a scan needs none. */
const ctx = (io: CaptureIO, execFile?: RunContext['execFile']): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore(),
  prompt: { text: async () => '', secret: async () => '' },
  makeClient: () => ({}) as ManagementClient,
  readFile: () => '',
  ...(execFile ? { execFile } : {}),
});

const LIVE = 'atlas_live_sk_0123456789abcdefABCDEF';
const TEST = 'atlas_test_sk_0123456789abcdefABCDEF';
const WH = 'whsec_abcdefghijklmnop';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-scan-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scan = async () => {
  const io = captureIO();
  const code = await run(['doctor', '--scan-dir', dir], ctx(io));
  expect(io.stdout() + io.stderr()).not.toContain(LIVE);
  expect(io.stdout() + io.stderr()).not.toContain(TEST);
  expect(io.stdout() + io.stderr()).not.toContain(WH);
  return { code, out: io.stdout() };
};

describe('atlas doctor --scan-dir', () => {
  it('a clean folder exits 0', async () => {
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node\nARG NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY\nENV NODE_ENV=production\n');
    expect((await scan()).code).toBe(0);
  });

  it('flags ARG defaults and ENV values by shape, with file and line and no value', async () => {
    writeFileSync(join(dir, 'Dockerfile'), `FROM node\nARG KEY=${LIVE}\nENV HOOK=${WH}\n`);
    const { code, out } = await scan();
    expect(code).toBe(1);
    expect(out).toContain(`${join(dir, 'Dockerfile')}:2`);
    expect(out).toContain(`${join(dir, 'Dockerfile')}:3`);
    expect(out).toContain('secret_value_in_build');
  });

  it('flags a secret passed as a build arg by name, with no default', async () => {
    writeFileSync(join(dir, 'Dockerfile.web'), 'FROM node\nARG ATLAS_SECRET_KEY\nENV ATLAS_SECRET_KEY=$ATLAS_SECRET_KEY\n');
    const { code, out } = await scan();
    expect(code).toBe(1);
    expect(out).toContain('Dockerfile.web:2');
    expect(out).not.toContain('Dockerfile.web:3');
    expect(out).toContain('ATLAS_SECRET_KEY is a secret');
  });

  it('follows ENV line continuations, and ignores comments', async () => {
    writeFileSync(join(dir, 'Dockerfile'), `FROM node\n# ARG X=${LIVE}\nENV A=1 \\\n  B=${LIVE}\nRUN echo ok\n`);
    const { out } = await scan();
    expect(out).toContain('Dockerfile:4');
    expect(out).not.toContain('Dockerfile:2');
  });

  it('flags compose build args in map and list form, not runtime environment', async () => {
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      `services:\n  web:\n    environment:\n      ATLAS_SECRET_KEY: \${ATLAS_SECRET_KEY}\n    build:\n      context: .\n      args:\n        PUBLIC: ok\n        ATLAS_SECRET_KEY: \${ATLAS_SECRET_KEY}\n  api:\n    build:\n      args:\n        - HOOK=${WH}\n`,
    );
    const { code, out } = await scan();
    expect(code).toBe(1);
    expect(out).toContain('docker-compose.yml:9');
    expect(out).toContain('docker-compose.yml:13');
    expect(out).not.toContain('docker-compose.yml:4');
  });

  it('skips compose that does not parse', async () => {
    writeFileSync(join(dir, 'compose.yaml'), 'services: [unclosed\n');
    expect((await scan()).code).toBe(0);
  });

  it('flags a folder holding both a dev and a prod key, across files; separate folders are fine', async () => {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'production.env'), `# header\nATLAS_SECRET_KEY=${LIVE}\n`);
    writeFileSync(join(dir, 'a', 'development.env'), `ATLAS_SECRET_KEY=${TEST}\n`);
    const { code, out } = await scan();
    expect(code).toBe(1);
    expect(out).toContain('production.env:2');
    expect(out).toContain('development.env:1');
    expect(out).toContain('dev_and_prod_keys_together');

    rmSync(join(dir, 'a', 'development.env'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'development.env'), `ATLAS_SECRET_KEY=${TEST}\n`);
    expect((await scan()).code).toBe(0);
  });

  it('flags a production key beside a development subfolder, which is what init can leave', async () => {
    writeFileSync(join(dir, 'production.env'), `ATLAS_SECRET_KEY=${LIVE}\n`);
    mkdirSync(join(dir, 'development'));
    writeFileSync(join(dir, 'development', 'atlas.env'), `ATLAS_SECRET_KEY=${TEST}\n`);
    const { code, out } = await scan();
    expect(code).toBe(1);
    expect(out).toContain('production.env:1');
    expect(out).toContain(`${join('development', 'atlas.env')}:1`);
    expect(out).toContain('dev_and_prod_keys_together');
  });

  it('does not treat sibling folders, a skipped folder or a symlink out as a subfolder', async () => {
    writeFileSync(join(dir, 'production.env'), `ATLAS_SECRET_KEY=${LIVE}\n`);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'atlas.env'), `ATLAS_SECRET_KEY=${TEST}\n`);
    const outside = mkdtempSync(join(tmpdir(), 'atlas-cli-scan-out-'));
    writeFileSync(join(outside, 'atlas.env'), `ATLAS_SECRET_KEY=${TEST}\n`);
    symlinkSync(outside, join(dir, 'development'));
    expect((await scan()).code).toBe(0);
    rmSync(outside, { recursive: true, force: true });

    rmSync(join(dir, 'production.env'));
    mkdirSync(join(dir, 'prod'));
    writeFileSync(join(dir, 'prod', 'atlas.env'), `ATLAS_SECRET_KEY=${LIVE}\n`);
    mkdirSync(join(dir, 'dev'));
    writeFileSync(join(dir, 'dev', 'atlas.env'), `ATLAS_SECRET_KEY=${TEST}\n`);
    expect((await scan()).code).toBe(0);
  });

  it('skips node_modules, .git, binary and big files, and symlinks', async () => {
    for (const d of ['node_modules', '.git']) {
      mkdirSync(join(dir, d));
      writeFileSync(join(dir, d, 'Dockerfile'), `ARG K=${LIVE}\n`);
    }
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'Dockerfile'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`ARG K=${LIVE}\n`)]));
    mkdirSync(join(dir, 'big'));
    writeFileSync(join(dir, 'big', 'Dockerfile'), `ARG K=${LIVE}\n${'#'.repeat(1024 * 1024 + 1)}\n`);
    const outside = mkdtempSync(join(tmpdir(), 'atlas-cli-scan-out-'));
    writeFileSync(join(outside, 'Dockerfile'), `ARG K=${LIVE}\n`);
    symlinkSync(outside, join(dir, 'link'));
    expect((await scan()).code).toBe(0);
    rmSync(outside, { recursive: true, force: true });
  });

  it('a missing folder is a clean error', async () => {
    const io = captureIO();
    expect(await run(['doctor', '--scan-dir', join(dir, 'nope')], ctx(io))).toBe(1);
    expect(io.stderr()).toContain('cannot read');
  });

  it('--json carries the findings, with no value', async () => {
    writeFileSync(join(dir, 'Dockerfile'), `ARG K=${LIVE}\n`);
    const io = captureIO();
    expect(await run(['doctor', '--scan-dir', dir, '--json'], ctx(io))).toBe(1);
    expect(io.stdout()).not.toContain(LIVE);
    expect(JSON.parse(io.stdout())).toMatchObject({ ok: false, findings: [{ line: 1, code: 'secret_value_in_build' }] });
  });
});

describe('atlas doctor --scan-image', () => {
  const docker = (history: string, env: string[]): { calls: string[][]; exec: NonNullable<RunContext['execFile']> } => {
    const calls: string[][] = [];
    return {
      calls,
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return args[0] === 'history' ? history : JSON.stringify(env);
      },
    };
  };

  it('calls docker with array args and flags history and env without the value', async () => {
    const { calls, exec } = docker(`RUN echo ok\n|1 KEY=${LIVE} /bin/sh -c build\n`, ['PATH=/bin', `ATLAS_WEBHOOK_SECRET=plainvalue`]);
    const io = captureIO();
    expect(await run(['doctor', '--scan-image', 'acme/web:1'], ctx(io, exec))).toBe(1);
    expect(calls[0]).toEqual(['docker', 'history', '--no-trunc', '--format', '{{.CreatedBy}}', 'acme/web:1']);
    expect(calls[1]).toEqual(['docker', 'inspect', '--format', '{{json .Config.Env}}', 'acme/web:1']);
    expect(io.stdout()).toContain('image acme/web:1 history:2');
    expect(io.stdout()).toContain('image acme/web:1 env:2');
    expect(io.stdout()).not.toContain(LIVE);
    expect(io.stdout()).not.toContain('plainvalue');
  });

  it('a clean image exits 0', async () => {
    const { exec } = docker('RUN echo ok\n', ['PATH=/bin']);
    expect(await run(['doctor', '--scan-image', 'acme/web:1'], ctx(captureIO(), exec))).toBe(0);
  });

  it('a missing docker binary gives a clear error', async () => {
    const io = captureIO();
    const exec = async () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    };
    expect(await run(['doctor', '--scan-image', 'x'], ctx(io, exec))).toBe(1);
    expect(io.stderr()).toContain('docker was not found');
  });

  it('an image docker cannot read is a clear error', async () => {
    const io = captureIO();
    const exec = async () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    };
    expect(await run(['doctor', '--scan-image', 'x'], ctx(io, exec))).toBe(1);
    expect(io.stderr()).toContain('could not read image x');
  });

  it('refuses a reference that would read as an option', async () => {
    const io = captureIO();
    const { calls, exec } = docker('', []);
    expect(await run(['doctor', '--scan-image=--help'], ctx(io, exec))).toBe(1);
    expect(calls).toEqual([]);
  });
});
