/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEmulatorEngine, type Engine, type EmulatorOptions } from './engine';
import type { Obj } from './openapi';

let doc: Obj | undefined;
/** The checked-in OpenAPI snapshot the SDK generators use; parsed once per test file. */
export const snapshot = (): Obj => (doc ??= JSON.parse(readFileSync(resolve(__dirname, '../../../sdks/rust/scripts/openapi.snapshot.json'), 'utf8')));

export const KEY = 'sk_test_emulator';

export const makeEngine = (o: Partial<EmulatorOptions> = {}): Engine => createEmulatorEngine({ openapi: snapshot(), webhookRetryDelaysMs: [], ...o });

export interface Called {
  status: number;
  json: any;
  headers: Headers;
}

export function client(engine: Engine, key: string | null = KEY) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Called> => {
    const res = await engine.handle(
      new Request(`http://emulator.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
}
