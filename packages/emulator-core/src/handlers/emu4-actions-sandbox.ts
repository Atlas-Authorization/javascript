/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from '../engine';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';

/**
 * The Action runtime the emulator runs, on node:vm. The in-sandbox bootstrap below is the real runtime's `api` object (same
 * names, limits and truncations); only the host side differs: a fresh vm context with no globals beyond the language's own
 * (no require, process, fetch, timers or console), code generation from strings disabled, the event handed over as a JSON
 * string parsed inside the context, a CPU timeout, and the result read back as a string. Nothing from the host is reachable.
 */
const ACTION_HTTP_LIMITS = { perAction: 5, perFlow: 10, urlMax: 2048, headersMax: 20, headerValueMax: 4096, bodyMax: 64 * 1024 } as const;
const ACTION_CONNECTOR_LIMITS = { perAction: 5, perFlow: 10, inputMax: 16 * 1024 } as const;

const BOOTSTRAP = `
'use strict';
function __atlasDeepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const k of Object.getOwnPropertyNames(o)) {
      try { __atlasDeepFreeze(o[k]); } catch (e) { /* getter, skip */ }
    }
    Object.freeze(o);
  }
  return o;
}
const event = __atlasDeepFreeze(globalThis.__atlas_event_raw);
try { delete globalThis.__atlas_event_raw; } catch (e) {}
const __atlas_result = {
  accessTokenClaims: {}, idTokenClaims: {}, appMetadata: {}, sessionData: {},
  externalIdSet: false, externalId: null,
  denied: false, denyReason: null, logs: [], http: [], connectorCalls: [], error: null,
  lockReason: null, pauseReason: null, suppressedAccessClaims: [], suppressedIdClaims: [],
  userEdits: {}, signUpPrefill: {}, signUpModify: {}, challenge: null, challengeAccept: null, exchangeSubject: null, messageRewrite: null,
};
function __atlasStr(v, max) { return v == null ? null : (String(v).trim().slice(0, max) || null); }
function __atlasClaimKey(k) { return String(k).slice(0, 256); }
var __ATLAS_HTTP_FORBIDDEN = ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'expect'];
function __atlasHttp(method, url, options) {
  options = options || {};
  if (__atlas_result.http.length >= ${ACTION_HTTP_LIMITS.perAction}) {
    throw new RangeError('api.http: at most ${ACTION_HTTP_LIMITS.perAction} requests per action run');
  }
  url = String(url);
  if (!/^https:\\/\\/[^\\s]+$/i.test(url) || url.length > ${ACTION_HTTP_LIMITS.urlMax}) {
    throw new TypeError('api.http: the url must be an https:// URL of at most ${ACTION_HTTP_LIMITS.urlMax} characters');
  }
  var headers = {};
  var lower = {};
  if (options.headers != null) {
    if (typeof options.headers !== 'object' || Array.isArray(options.headers)) throw new TypeError('api.http: headers must be an object');
    var names = Object.keys(options.headers);
    if (names.length > ${ACTION_HTTP_LIMITS.headersMax}) throw new RangeError('api.http: at most ${ACTION_HTTP_LIMITS.headersMax} headers');
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new TypeError('api.http: invalid header name ' + name);
      if (__ATLAS_HTTP_FORBIDDEN.indexOf(name.toLowerCase()) >= 0) throw new TypeError('api.http: the ' + name + ' header is set by Atlas');
      var value = String(options.headers[name]);
      if (value.length > ${ACTION_HTTP_LIMITS.headerValueMax} || /[\\r\\n]/.test(value)) throw new TypeError('api.http: invalid value for header ' + name);
      headers[name] = value;
      lower[name.toLowerCase()] = true;
    }
  }
  var body = null;
  if (options.body !== undefined && options.body !== null) {
    if (method === 'GET') throw new TypeError('api.http.get: a GET request has no body');
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (typeof options.body !== 'string' && !lower['content-type']) headers['content-type'] = 'application/json';
    if (body.length > ${ACTION_HTTP_LIMITS.bodyMax}) throw new RangeError('api.http: the body is over ${ACTION_HTTP_LIMITS.bodyMax} bytes');
  }
  var saveAs = null;
  if (options.saveResponseAs != null) {
    saveAs = String(options.saveResponseAs);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(saveAs)) throw new TypeError('api.http: saveResponseAs must be a metadata key (letters, digits, _)');
  }
  __atlas_result.http.push({ method: method, url: url, headers: headers, body: body, saveResponseAs: saveAs });
}
function __atlasConnectorSend(name, operation, input) {
  if (__atlas_result.connectorCalls.length >= ${ACTION_CONNECTOR_LIMITS.perAction}) {
    throw new RangeError('api.connector.send: at most ${ACTION_CONNECTOR_LIMITS.perAction} calls per action run');
  }
  name = String(name); operation = String(operation);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new TypeError('api.connector.send: name is the connector name you gave it');
  if (!/^[a-z_]{1,64}$/.test(operation)) throw new TypeError('api.connector.send: operation is an operation of the connector, e.g. send_sms');
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('api.connector.send: input must be an object');
  if (JSON.stringify(input).length > ${ACTION_CONNECTOR_LIMITS.inputMax}) throw new RangeError('api.connector.send: input is over ${ACTION_CONNECTOR_LIMITS.inputMax} bytes');
  __atlas_result.connectorCalls.push({ name: name, operation: operation, input: JSON.parse(JSON.stringify(input)) });
}
const api = Object.freeze({
  connector: Object.freeze({ send: function (name, operation, input) { __atlasConnectorSend(name, operation, input); } }),
  access: Object.freeze({
    deny: function (reason) {
      __atlas_result.denied = true;
      __atlas_result.denyReason = (reason == null ? 'Access denied.' : String(reason)).slice(0, 512);
    },
    lock: function (reason) {
      __atlas_result.lockReason = (reason == null ? 'Account locked.' : String(reason)).slice(0, 512);
    },
    pause: function (reason) {
      __atlas_result.pauseReason = (reason == null ? 'Confirm the deletion to continue.' : String(reason)).slice(0, 512);
    },
  }),
  exchange: Object.freeze({
    setUserById: function (id) {
      __atlas_result.exchangeSubject = { by: 'id', value: String(id).trim().slice(0, 255), create: false };
    },
    setUserByEmail: function (email, o) {
      o = o || {};
      __atlas_result.exchangeSubject = { by: 'email', value: String(email).trim().toLowerCase().slice(0, 320), create: o.create === true,
        externalId: o.externalId == null ? undefined : String(o.externalId).trim().slice(0, 255), emailVerified: o.emailVerified === true };
    },
    setUserByExternalId: function (externalId, o) {
      o = o || {};
      __atlas_result.exchangeSubject = { by: 'external_id', value: String(externalId).trim().slice(0, 255), create: o.create === true,
        email: o.email == null ? undefined : String(o.email).trim().toLowerCase().slice(0, 320), emailVerified: o.emailVerified === true };
    },
  }),
  message: Object.freeze({
    rewrite: function (c) {
      if (c == null || typeof c !== 'object') throw new TypeError('api.message.rewrite: an object is required');
      var vars = {};
      if (c.variables != null) {
        if (typeof c.variables !== 'object' || Array.isArray(c.variables)) throw new TypeError('api.message.rewrite: variables must be an object');
        Object.keys(c.variables).slice(0, 50).forEach(function (k) { vars[String(k).slice(0, 64)] = String(c.variables[k]).slice(0, 2000); });
      }
      var out = { variables: vars };
      if (c.subject != null) out.subject = String(c.subject).slice(0, 500);
      if (c.text != null) out.text = String(c.text).slice(0, 20000);
      __atlas_result.messageRewrite = out;
    },
  }),
  challenge: Object.freeze({
    set: function (c) {
      if (c == null || typeof c !== 'object' || typeof c.prompt !== 'string' || !c.prompt) throw new TypeError('api.challenge.set: a { prompt } string is required');
      var state = c.state === undefined ? null : c.state;
      if (JSON.stringify(state === null ? 'x' : state).length > 2048) throw new RangeError('api.challenge.set: state is over 2048 bytes');
      __atlas_result.challenge = { prompt: c.prompt.slice(0, 512), hint: c.hint == null ? null : String(c.hint).slice(0, 256), state: state };
    },
    accept: function (o) {
      var amr = o && Array.isArray(o.amr) ? o.amr.slice(0, 5).map(function (a) { return String(a).slice(0, 32); }) : ['custom'];
      __atlas_result.challengeAccept = { amr: amr };
    },
  }),
  accessToken: Object.freeze({
    setCustomClaim: function (k, v) { __atlas_result.accessTokenClaims[__atlasClaimKey(k)] = v; },
    suppressClaim: function (k) { if (__atlas_result.suppressedAccessClaims.length < 50) __atlas_result.suppressedAccessClaims.push(__atlasClaimKey(k)); },
  }),
  idToken: Object.freeze({
    setCustomClaim: function (k, v) { __atlas_result.idTokenClaims[__atlasClaimKey(k)] = v; },
    suppressClaim: function (k) { if (__atlas_result.suppressedIdClaims.length < 50) __atlas_result.suppressedIdClaims.push(__atlasClaimKey(k)); },
  }),
  signUp: Object.freeze({
    prefill: function (k, v) { __atlas_result.signUpPrefill[__atlasClaimKey(k)] = String(v).slice(0, 1024); },
    modify: function (k, v) { __atlas_result.signUpModify[__atlasClaimKey(k)] = String(v).slice(0, 1024); },
  }),
  session: Object.freeze({
    setCustomData: function (k, v) { __atlas_result.sessionData[String(k).slice(0, 64)] = v; },
  }),
  user: Object.freeze({
    setAppMetadata: function (k, v) { __atlas_result.appMetadata[__atlasClaimKey(k)] = v; },
    setBanned: function (banned, reason) {
      __atlas_result.userEdits.banned = { value: banned === true, reason: __atlasStr(reason, 512) };
    },
    setEmailVerified: function (verified) { __atlas_result.userEdits.emailVerified = verified === true; },
    setName: function (first, last) {
      if (first !== undefined) __atlas_result.userEdits.firstName = __atlasStr(first, 255);
      if (last !== undefined) __atlas_result.userEdits.lastName = __atlasStr(last, 255);
    },
    setImage: function (url) {
      var u = __atlasStr(url, 2048);
      if (u !== null && !/^https:\\/\\/[^\\s]+$/i.test(u)) throw new TypeError('api.user.setImage: the url must be an https:// URL');
      __atlas_result.userEdits.imageUrl = u;
    },
    setExternalId: function (id) {
      __atlas_result.externalIdSet = true;
      __atlas_result.externalId = id == null ? null : String(id).trim().slice(0, 255) || null;
    },
  }),
  http: Object.freeze({
    get: function (url, options) { __atlasHttp('GET', url, options); },
    post: function (url, body, options) {
      var o = {};
      if (options) { for (var k in options) { if (Object.prototype.hasOwnProperty.call(options, k)) o[k] = options[k]; } }
      o.body = body;
      __atlasHttp('POST', url, o);
    },
  }),
  console: Object.freeze({
    log: function () {
      var parts = Array.prototype.slice.call(arguments).map(function (a) {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
      });
      if (__atlas_result.logs.length < 100) __atlas_result.logs.push(parts.join(' ').slice(0, 2000));
    },
  }),
});
`;

export interface ActionRunResult {
  accessTokenClaims: Obj;
  idTokenClaims: Obj;
  appMetadata: Obj;
  sessionData: Obj;
  denied: boolean;
  denyReason: string | null;
  lockReason: string | null;
  pauseReason: string | null;
  suppressedAccessClaims: string[];
  suppressedIdClaims: string[];
  userEdits: Obj;
  signUpPrefill: Obj;
  signUpModify: Obj;
  httpRequests: Obj[];
  connectorCalls: Obj[];
  logs: string[];
  error: string | null;
}

/** Timeout of one Action run, in CPU milliseconds (the real service allows 2 s; the emulator keeps a test suite fast). */
export const ACTION_TIMEOUT_MS = 100;
const MAX_OUT = 1_000_000;

const vmModule = (): typeof import('node:vm') | null => {
  try {
    return (process as any).getBuiltinModule?.('node:vm') ?? null;
  } catch {
    return null;
  }
};
/** True when the emulator can run Action code (Node 22+); false in a browser, where the declarative reader is used. */
export const sandboxAvailable = (): boolean => vmModule() !== null;

/** Code written as a handler module (`exports.onExecute...`, `module.exports`) is not the runtime's form: the caller reads it declaratively. */
export const isRuntimeForm = (code: string): boolean => !/\b(?:module\.exports|exports\.on[A-Z]\w*)\b/.test(code);

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);
const strMap = (v: unknown): Obj => Object.fromEntries(Object.entries(obj(v)).slice(0, 50).filter(([, x]) => typeof x === 'string'));
const empty = (error: string | null): ActionRunResult => ({ accessTokenClaims: {}, idTokenClaims: {}, appMetadata: {}, sessionData: {}, denied: false, denyReason: null, lockReason: null, pauseReason: null, suppressedAccessClaims: [], suppressedIdClaims: [], userEdits: {}, signUpPrefill: {}, signUpModify: {}, httpRequests: [], connectorCalls: [], logs: [], error });

/** The requests the sandbox recorded, checked again here: the sandbox's output is untrusted data. */
function httpOf(raw: unknown): Obj[] {
  if (!Array.isArray(raw)) return [];
  const out: Obj[] = [];
  for (const item of raw.slice(0, ACTION_HTTP_LIMITS.perAction)) {
    const r = obj(item);
    if (r.method !== 'GET' && r.method !== 'POST') continue;
    if (typeof r.url !== 'string' || r.url.length > ACTION_HTTP_LIMITS.urlMax) continue;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.username || u.password) continue;
    const headers = Object.fromEntries(Object.entries(obj(r.headers)).slice(0, ACTION_HTTP_LIMITS.headersMax).filter(([, v]) => typeof v === 'string'));
    out.push({ method: r.method, url: u.toString(), headers, body: typeof r.body === 'string' ? r.body : null, saveResponseAs: typeof r.saveResponseAs === 'string' ? r.saveResponseAs : null });
  }
  return out;
}

/**
 * Run one Action's code. Never throws: a syntax error, a thrown exception, a timeout or a promise that never settles comes back
 * as `error` (the caller fails closed or open by trigger, as the real flow does). Returns null when the code is not in the
 * runtime's form or vm is not available, so the caller can read it declaratively instead.
 */
export function runActionCode(event: Obj, code: string): ActionRunResult | null {
  const vm = vmModule();
  if (!vm || !isRuntimeForm(code)) return null;
  const literal = JSON.stringify(JSON.stringify(event));
  const head = BOOTSTRAP.replace("'use strict';", () => `'use strict';\nglobalThis.__atlas_event_raw = JSON.parse(${literal});`);
  const src =
    head +
    '\n;(async function () {\n' +
    code +
    '\n})().then(' +
    'function () { globalThis.__atlas_out = JSON.stringify(__atlas_result); },' +
    'function (e) {' +
    '  __atlas_result.error = (e && e.message) ? String(e.message).slice(0,512) : String(e).slice(0,512);' +
    '  globalThis.__atlas_out = JSON.stringify(__atlas_result);' +
    '})';
  let json: unknown;
  try {
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
    new vm.Script(src).runInContext(context, { timeout: ACTION_TIMEOUT_MS });
    json = vm.runInContext('globalThis.__atlas_out', context, { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    return empty(String((err as Error)?.message ?? err).slice(0, 512));
  }
  // An awaited promise that never settles leaves nothing behind: the real service's watchdog reports the same.
  if (typeof json !== 'string') return empty('Action timed out.');
  if (json.length > MAX_OUT) return empty('Action output is too large.');
  let p: Obj;
  try {
    p = JSON.parse(json) as Obj;
  } catch {
    return empty('Action returned an unreadable result.');
  }
  const edits = obj(p.userEdits);
  const userEdits: Obj = {};
  const banned = obj(edits.banned);
  if (typeof banned.value === 'boolean') userEdits.banned = { value: banned.value, reason: typeof banned.reason === 'string' ? banned.reason : null };
  if (typeof edits.emailVerified === 'boolean') userEdits.emailVerified = edits.emailVerified;
  for (const k of ['firstName', 'lastName', 'imageUrl']) if (edits[k] === null || typeof edits[k] === 'string') userEdits[k] = edits[k];
  const calls = (Array.isArray(p.connectorCalls) ? p.connectorCalls : []).slice(0, ACTION_CONNECTOR_LIMITS.perAction).map(obj).filter((c) => typeof c.name === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(c.name) && typeof c.operation === 'string' && /^[a-z_]{1,64}$/.test(c.operation));
  return {
    accessTokenClaims: obj(p.accessTokenClaims),
    idTokenClaims: obj(p.idTokenClaims),
    appMetadata: obj(p.appMetadata),
    sessionData: obj(p.sessionData),
    denied: p.denied === true,
    denyReason: typeof p.denyReason === 'string' ? p.denyReason : null,
    lockReason: typeof p.lockReason === 'string' ? p.lockReason : null,
    pauseReason: typeof p.pauseReason === 'string' ? p.pauseReason : null,
    suppressedAccessClaims: names(p.suppressedAccessClaims),
    suppressedIdClaims: names(p.suppressedIdClaims),
    userEdits,
    signUpPrefill: strMap(p.signUpPrefill),
    signUpModify: strMap(p.signUpModify),
    httpRequests: httpOf(p.http),
    connectorCalls: calls,
    logs: Array.isArray(p.logs) ? p.logs.map(String) : [],
    error: typeof p.error === 'string' ? p.error : null,
  };
}

/** One row per Action run (what the emulator saw: outcome, deny reason, logs, the requests `api.http` queued), read at `/__emulator/actions/runs`. */
export const actionRuns = engineState((e: Engine) => new Table('action_runs', e.clock.now, 'arun'));
