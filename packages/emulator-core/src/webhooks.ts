/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from './engine';
import type { Obj } from './openapi';
import { GATED_EVENTS, WILDCARD_GATE_DATE } from './event-gate';
import { newId } from './store';
import { chargeBudget } from './handlers/platform';
import { deliveryHeaders, evictToken, filtersMatch, takeRate } from './webhook-ext';

const gated = new Set(GATED_EVENTS);
export const INCLUDE_NEW_EVENT_TYPES = 'include_new_event_types';

/** Whether an endpoint subscribed to `type`: naming it always delivers; `*` skips events added after the endpoint (see `GATED_EVENTS`) unless it opted in. */
export function subscribed(enabled: string[], type: string, endpointCreatedAt: number): boolean {
  if (enabled.includes(type)) return true;
  if (!enabled.includes('*')) return false;
  if (!gated.has(type) || enabled.includes(INCLUDE_NEW_EVENT_TYPES)) return true;
  return endpointCreatedAt >= Date.parse(`${WILDCARD_GATE_DATE}T00:00:00.000Z`);
}

export interface EmittedEvent {
  id: string;
  type: string;
  created_at: number;
  payload: Obj;
}

export interface DeliveryAttempt {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  /** HTTP status the receiver answered, or null on a network failure. */
  response_status: number | null;
  success: boolean;
  error: string | null;
  at: number;
}

export interface Fault {
  endpointId?: string;
  /** An HTTP status to answer instead of delivering, or `network` to fail the connection. */
  status: number | 'network';
  /** How many deliveries it applies to. */
  times: number;
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmac(keyBytes: Uint8Array, material: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(material) as BufferSource)));
}

/**
 * The headers of one delivery, both families: `atlas-id` / `atlas-timestamp` (epoch ms) /
 * `atlas-signature: v1,<base64>` keyed with the secret string as given, and the Standard Webhooks
 * `webhook-*` headers (seconds, key = base64 part of `whsec_<base64>`).
 */
export async function signDelivery(input: { secret: string; id: string; timestampMs: number; body: string }): Promise<Record<string, string>> {
  const atlas = await hmac(enc.encode(input.secret), `${input.id}.${input.timestampMs}.${input.body}`);
  const sec = Math.floor(input.timestampMs / 1000);
  const raw = input.secret.startsWith('whsec_') ? input.secret.slice(6) : input.secret;
  let std: string;
  try {
    std = await hmac(unb64(raw), `${input.id}.${sec}.${input.body}`);
  } catch {
    std = await hmac(enc.encode(raw), `${input.id}.${sec}.${input.body}`);
  }
  return {
    'atlas-id': input.id,
    'atlas-timestamp': String(input.timestampMs),
    'atlas-signature': `v1,${atlas}`,
    'webhook-id': input.id,
    'webhook-timestamp': String(sec),
    'webhook-signature': `v1,${std}`,
  };
}

export class WebhookService {
  readonly events: EmittedEvent[] = [];
  readonly deliveries: DeliveryAttempt[] = [];
  readonly faults: Fault[] = [];
  private inflight = new Set<Promise<void>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly engine: Engine) {}

  /** A fresh secret in the `whsec_<base64>` form both verifier families accept. */
  newSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return `whsec_${b64(bytes)}`;
  }

  emit(type: string, data: Obj, actor: Obj | null = null): EmittedEvent {
    const now = this.engine.clock.now();
    const id = newId('evt', now);
    const payload: Obj = { id, type, timestamp: now, instance_id: this.engine.instanceId, actor, idempotency_key: id, data };
    const event: EmittedEvent = { id, type, created_at: now, payload };
    this.events.push(event);
    // Events and fan-out are counted against the write budget and announced when over; never dropped.
    if (type !== 'write_budget.exceeded') chargeBudget(this.engine, 'events');
    for (const ep of this.engine.db.endpoints.all()) {
      if (ep.active === false) continue;
      const wanted: string[] = ep.enabled_events ?? ['*'];
      if (subscribed(wanted, type, ep.created_at ?? 0) && filtersMatch(ep.filters, data)) {
        if (type !== 'write_budget.exceeded') chargeBudget(this.engine, 'webhook_fanout');
        this.dispatch(ep.id, event, 1);
      }
    }
    return event;
  }

  /** Deliver one stored event to one endpoint again (redeliver, test). Resolves when the first attempt has finished. */
  async redeliver(endpointId: string, eventId: string): Promise<boolean> {
    const ev = this.events.find((e) => e.id === eventId);
    if (!ev || !this.engine.db.endpoints.get(endpointId)) return false;
    this.dispatch(endpointId, ev, 1);
    await this.flush();
    return true;
  }

  private dispatch(endpointId: string, event: EmittedEvent, attempt: number): void {
    const p = this.deliver(endpointId, event, attempt)
      .catch(() => undefined)
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private takeFault(endpointId: string): Fault | undefined {
    const f = this.faults.find((x) => (!x.endpointId || x.endpointId === endpointId) && x.times > 0);
    if (f) f.times--;
    return f;
  }

  private async deliver(endpointId: string, event: EmittedEvent, attempt: number): Promise<void> {
    const ep = this.engine.db.endpoints.get(endpointId);
    if (!ep || ep.active === false) return;
    // Over the endpoint's max_rps: wait for the next window; the attempt is not consumed.
    if (!takeRate(this.engine, ep)) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.dispatch(endpointId, event, attempt);
      }, 1000);
      (t as { unref?: () => void }).unref?.();
      this.timers.add(t);
      return;
    }
    const body = JSON.stringify(event.payload);
    const now = this.engine.clock.now();
    const deliveryId = newId('whdl', now);
    let status: number | null = null;
    let error: string | null = null;
    const fault = this.takeFault(endpointId);
    if (fault) {
      if (fault.status === 'network') error = 'injected network failure';
      else status = fault.status;
    } else {
      try {
        const headers = { 'content-type': 'application/json', 'user-agent': 'Atlas-Emulator/1', ...(await deliveryHeaders(this.engine, ep)), ...(await signDelivery({ secret: ep.secret, id: event.id, timestampMs: now, body })) };
        const res = await (this.engine.options.fetch ?? fetch)(ep.url, { method: 'POST', headers, body });
        status = res.status;
        if (status === 401) evictToken(this.engine, endpointId);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    const success = status !== null && status >= 200 && status < 300;
    this.deliveries.push({ id: deliveryId, endpoint_id: endpointId, event_id: event.id, event_type: event.type, attempt, response_status: status, success, error, at: now });
    this.engine.db.endpoints.update(endpointId, success
      ? { consecutive_failures: 0, last_success_at: now, failing_since: null }
      : { consecutive_failures: (ep.consecutive_failures ?? 0) + 1, failing_since: ep.failing_since ?? now, last_failure: { at: now, status, error } });
    if (!success) {
      const delays = this.engine.options.webhookRetryDelaysMs ?? [1000, 5000, 30000];
      const delay = delays[attempt - 1];
      if (delay !== undefined) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          this.dispatch(endpointId, event, attempt + 1);
        }, delay);
        (t as { unref?: () => void }).unref?.();
        this.timers.add(t);
      }
    }
  }

  /** Wait until every delivery attempt in flight has finished (retries still waiting on a timer are not awaited). */
  async flush(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.flush();
  }

  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.events.length = 0;
    this.deliveries.length = 0;
    this.faults.length = 0;
  }
}
