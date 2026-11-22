import type { ConfigHttp } from '../../config-http';
import type { Json } from '../../serialize';
import type { CollectionSpec, ResourceSpec, SingletonSpec } from '../config';
import { simpleSingletonSpec } from './simple';

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `messaging_settings`: automatic suppression, failover on/off and how long the message ledger is kept
 * (GET/PUT /v1/messaging/settings).
 */
const MESSAGING_SETTINGS: SingletonSpec = simpleSingletonSpec({
  type: 'messaging_settings',
  path: '/v1/messaging/settings',
  fileKeys: ['auto_suppress', 'failover_enabled', 'ledger_retention_days'],
});

/**
 * `sms_country_routes`: numbers in a country go through the named provider first (`provider_id` is the id of your
 * SMS provider or one of its fallbacks; ids differ per instance, so list them with `atlas api GET /v1/messaging_providers/sms/fallbacks`).
 * Keyed by country. Never pruned unless `--prune-type sms_country_routes`.
 */
const SMS_COUNTRY_ROUTES: CollectionSpec = {
  kind: 'collection',
  type: 'sms_country_routes',
  prune: false,
  fileKeys: ['country', 'provider_id'],
  keyOf: (c) => String(isObj(c) ? (c.country ?? '') : '').toUpperCase(),
  async fetchLive(http) {
    const res = await http.get<{ data?: Array<Record<string, Json>> }>('/v1/messaging/country_routes');
    return (Array.isArray(res?.data) ? res.data : []).map((r) => ({
      key: String(r.country ?? '').toUpperCase(),
      id: String(r.country ?? ''),
      config: { country: String(r.country ?? '').toUpperCase(), provider_id: r.provider_id ?? null },
    }));
  },
  async create(http, config) {
    const c = isObj(config) ? config : {};
    await http.put('/v1/messaging/country_routes', { country: c.country ?? null, provider_id: c.provider_id ?? null });
  },
  async update(http, _live, config) {
    const c = isObj(config) ? config : {};
    await http.put('/v1/messaging/country_routes', { country: c.country ?? null, provider_id: c.provider_id ?? null });
  },
  async remove(http, live) {
    await http.delete(`/v1/messaging/country_routes/${encodeURIComponent(live.id)}`);
  },
};

const CHANNELS = ['email', 'sms', 'push'] as const;

/**
 * `messaging_fallbacks`: the ordered fallback providers of the email, SMS and push channels. An entry is
 * `{ channel, transport, from_address, config, secrets, position, status }`; it is keyed by
 * channel + transport + from address. `config` holds the non-secret settings, `secrets` the credentials
 * (write-only: put `${ENV_VAR}` there; they are never exported or compared). Never pruned unless
 * `--prune-type messaging_fallbacks`.
 */
const MESSAGING_FALLBACKS: CollectionSpec = {
  kind: 'collection',
  type: 'messaging_fallbacks',
  prune: false,
  fileKeys: ['channel', 'transport', 'from_address', 'config', 'secrets', 'position', 'status'],
  writeOnly: ['secrets'],
  keyOf: (c) => {
    const o = isObj(c) ? c : {};
    return `${String(o.channel ?? '')}/${String(o.transport ?? '')}/${String(o.from_address ?? '') || '-'}`;
  },
  async fetchLive(http) {
    const out: Array<{ key: string; id: string; config: Json }> = [];
    for (const channel of CHANNELS) {
      const res = await http.get<{ data?: Array<Record<string, Json>> }>(`/v1/messaging_providers/${channel}/fallbacks`);
      for (const r of Array.isArray(res?.data) ? res.data : []) {
        out.push({
          key: `${channel}/${String(r.transport ?? '')}/${String(r.from_address ?? '') || '-'}`,
          id: `${channel}:${String(r.id ?? '')}`,
          config: {
            channel,
            transport: r.transport ?? null,
            ...(r.from_address ? { from_address: r.from_address } : {}),
            config: isObj(r.config) ? r.config : {},
            position: r.position ?? null,
            status: r.status ?? 'active',
          },
        });
      }
    }
    return out;
  },
  async create(http, config) {
    const c = isObj(config) ? config : {};
    await http.post(`/v1/messaging_providers/${String(c.channel)}/fallbacks`, body(c));
  },
  async update(http, live, config) {
    const c = isObj(config) ? config : {};
    const [channel, id] = live.id.split(':');
    await http.put(`/v1/messaging_providers/${channel}/fallbacks/${encodeURIComponent(id ?? '')}`, body(c));
  },
  async remove(http, live) {
    const [channel, id] = live.id.split(':');
    await http.delete(`/v1/messaging_providers/${channel}/fallbacks/${encodeURIComponent(id ?? '')}`);
  },
  validate(config) {
    const c = isObj(config) ? config : {};
    return (CHANNELS as readonly string[]).includes(String(c.channel)) ? [] : ['messaging_fallbacks: channel must be email, sms or push.'];
  },
};

function body(c: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of ['transport', 'from_address', 'position', 'status']) if (c[k] !== undefined) out[k] = c[k]!;
  // Credentials go in with the settings: the API stores them write-only.
  const config = { ...(isObj(c.config) ? c.config : {}), ...(isObj(c.secrets) ? c.secrets : {}) };
  if (Object.keys(config).length) out.config = config;
  return out;
}


/** Providers whose callbacks need no verification secret (the URL token or the provider auth token already stored authorises them). */
const NO_SECRET_RECEIVERS = ['brevo', 'smtp2go', 'postmark', 'twilio', 'plivo'] as const;

/**
 * `message_receivers`: where your email and SMS providers report bounces, complaints and delivery. Keyed by
 * provider. `secret` is the verification secret of the provider's webhook (write-only: put `${ENV_VAR}`; never
 * exported or compared). Providers that need none (brevo, smtp2go, postmark, twilio, plivo) are listed with just
 * `provider`: their callback URL and token come from `GET /v1/message_receivers`. Never pruned unless
 * `--prune-type message_receivers`; removing deletes the stored secret.
 */
const MESSAGE_RECEIVERS: CollectionSpec = {
  kind: 'collection',
  type: 'message_receivers',
  prune: false,
  fileKeys: ['provider', 'secret'],
  writeOnly: ['secret'],
  keyOf: (c) => String(isObj(c) ? (c.provider ?? '') : ''),
  async fetchLive(http) {
    const res = await http.get<{ data?: Array<Record<string, Json>> }>('/v1/message_receivers');
    return (Array.isArray(res?.data) ? res.data : [])
      .filter((r) => r.secret_set === true || (NO_SECRET_RECEIVERS as readonly string[]).includes(String(r.provider)))
      .map((r) => ({ key: String(r.provider), id: String(r.provider), config: { provider: String(r.provider) } }));
  },
  async create(http, config) {
    await putReceiver(http, config);
  },
  async update(http, _live, config) {
    await putReceiver(http, config);
  },
  async remove(http, live) {
    if ((NO_SECRET_RECEIVERS as readonly string[]).includes(live.id)) return;
    await http.delete(`/v1/message_receivers/${encodeURIComponent(live.id)}`);
  },
  validate(config) {
    const c = isObj(config) ? config : {};
    const provider = String(c.provider ?? '');
    if (!provider) return ['message_receivers: provider is required.'];
    const noSecret = (NO_SECRET_RECEIVERS as readonly string[]).includes(provider);
    if (noSecret && c.secret !== undefined) return [`message_receivers ${provider}: needs no secret; remove the key.`];
    if (!noSecret && (typeof c.secret !== 'string' || !c.secret)) return [`message_receivers ${provider}: secret is required.`];
    return [];
  },
};

async function putReceiver(http: ConfigHttp, config: Json): Promise<void> {
  const c = isObj(config) ? config : {};
  if (c.secret === undefined) return;
  await http.put(`/v1/message_receivers/${encodeURIComponent(String(c.provider))}`, { secret: c.secret });
}

export const MESSAGING_DELIVERY_SPECS: ResourceSpec[] = [MESSAGING_SETTINGS, SMS_COUNTRY_ROUTES, MESSAGING_FALLBACKS, MESSAGE_RECEIVERS];
