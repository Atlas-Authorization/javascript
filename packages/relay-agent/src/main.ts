#!/usr/bin/env node
/**
 * Atlas relay agent. Outbound-only: it long-polls Atlas for jobs and posts results back, so no inbound
 * port is ever opened. Configuration (environment):
 *   ATLAS_RELAY_URL     Atlas API origin, e.g. https://api.atlasauth.net
 *   ATLAS_RELAY_TOKEN   the agent token (rla_...)
 *   RELAY_ALLOW         comma-separated destinations this agent may reach (host[:port], *.domain[:port]) — required
 *   RELAY_CLIENT_CERT / RELAY_CLIENT_KEY   optional PEM file paths for mutual TLS to Atlas
 *   RELAY_ALLOW_WRITE=1  run directory write-back jobs (create / change / delete entries); off by default
 *   RELAY_ALLOW_SQL=1    run SQL write-back jobs (needs the database driver installed next to the agent); off by default
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { Attribute, Change, Client } from 'ldapts';
import { runSql } from './sql';
import { handleJob, type Executors, type Job, type LdapEntry } from './agent';

const VERSION = '0.2.0';
const base = process.env.ATLAS_RELAY_URL?.replace(/\/$/, '');
const token = process.env.ATLAS_RELAY_TOKEN;
const allow = (process.env.RELAY_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!base || !token || allow.length === 0) {
  console.error('ATLAS_RELAY_URL, ATLAS_RELAY_TOKEN and RELAY_ALLOW are required.');
  process.exit(2);
}
const cert = process.env.RELAY_CLIENT_CERT ? readFileSync(process.env.RELAY_CLIENT_CERT) : undefined;
const key = process.env.RELAY_CLIENT_KEY ? readFileSync(process.env.RELAY_CLIENT_KEY) : undefined;

function call(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const url = new URL(base + path);
  const data = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'http:' ? httpRequest : request)(
      url,
      {
        method: 'POST',
        cert,
        key,
        timeout: 40_000,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-atlas-relay-version': VERSION, 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

const toEntry = (e: Record<string, unknown>): LdapEntry => {
  const { dn, ...rest } = e;
  const attributes: LdapEntry['attributes'] = {};
  for (const [k, v] of Object.entries(rest)) {
    attributes[k] = Buffer.isBuffer(v) ? v.toString('hex') : Array.isArray(v) ? v.map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x))) : v == null ? undefined : String(v);
  }
  return { dn: String(dn), attributes };
};

const perms = { write: process.env.RELAY_ALLOW_WRITE === '1', sql: process.env.RELAY_ALLOW_SQL === '1' };

const executors: Executors = {
  sql: runSql,
  openLdap(url) {
    const c = new Client({ url, timeout: 10_000, connectTimeout: 10_000 });
    return {
      bind: (dn, pw) => c.bind(dn, pw),
      async search(baseDN, filter, pageSize, returning) {
        const { searchEntries } = await c.search(baseDN, { scope: 'sub', filter, explicitBufferAttributes: ['objectGUID'], ...(returning?.length ? { attributes: returning } : {}), ...(pageSize ? { paged: { pageSize } } : {}) });
        return searchEntries.map((e) => toEntry(e as Record<string, unknown>));
      },
      async add(dn, attributes) {
        await c.add(dn, attributes);
      },
      async modify(dn, changes) {
        // unicodePwd must reach the server as raw bytes: the job carries it base64-encoded.
        const toValue = (attribute: string, v: string) => (attribute.toLowerCase() === 'unicodepwd' ? Buffer.from(v, 'base64') : v);
        await c.modify(
          dn,
          changes.map((ch) => new Change({ operation: ch.operation, modification: new Attribute({ type: ch.attribute, values: (ch.values ?? []).map((v) => toValue(ch.attribute, v)) as string[] }) })),
        );
      },
      async del(dn) {
        await c.del(dn);
      },
      unbind: () => c.unbind(),
    };
  },
  async http(req) {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs ?? 10_000), redirect: 'manual' });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: (await res.text()).slice(0, 256 * 1024) };
  },
};

async function main() {
  console.log(`atlas-relay-agent ${VERSION} polling ${base}`);
  let backoff = 1000;
  for (;;) {
    try {
      const { status, json } = await call('/v1/relay/poll');
      backoff = 1000;
      if (status === 401) throw new Error('Atlas rejected the agent token (revoked, rotated or wrong certificate).');
      if (status !== 200) continue;
      const job = json as Job;
      let outcome: { result: unknown } | { error: string };
      try {
        outcome = { result: await handleJob(job, allow, executors, perms) };
      } catch (e) {
        outcome = { error: e instanceof Error ? e.message : 'The job failed.' };
      }
      await call(`/v1/relay/jobs/${job.id}/result`, outcome);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
void main();
