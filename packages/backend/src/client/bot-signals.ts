import { type RequestFn } from './request';

/**
 * One append-only row of the anti-bot signal lake: a fully anonymised feature
 * vector per auth interaction. IPs are salt-hashed at ingest and behaviour is
 * timing aggregates only — nothing here is a raw secret.
 */
export interface BotSignal {
  object: 'bot_signal';
  id: string;
  attempt_id: string | null;
  user_id: string | null;
  /** sign_in | sign_up | telemetry */
  kind: string;
  /** client_beacon | server */
  source: string;
  ip_hash: string | null;
  ip_subnet: string | null;
  asn: number | null;
  geo_country: string | null;
  geo_city: string | null;
  is_datacenter: boolean | null;
  is_anonymizer: boolean | null;
  header_fingerprint: string | null;
  accept_language: string | null;
  device_id: string | null;
  device_fingerprint: string | null;
  device_features: Record<string, unknown>;
  behavior_features: Record<string, unknown>;
  captcha_provider: string | null;
  captcha_score: number | null;
  risk_level: string | null;
  risk_score: number | null;
  risk_signals: Record<string, unknown>;
  heuristic_score: number | null;
  heuristic_reasons: unknown[];
  /** started | completed | failed | challenged | abandoned */
  outcome: string | null;
  created_at: number;
}

/** A supervised training label, attachable after the interaction. */
export interface BotLabel {
  object: 'bot_label';
  id: string;
  subject_type: 'user' | 'device' | 'ip_hash' | 'attempt';
  subject_id: string;
  label: 'bot' | 'human' | 'suspect';
  /** admin_ban | captcha_failed | mfa_failed | verified_human | analyst | model */
  source: string;
  confidence: number;
  note: string | null;
  labeled_by: string | null;
  created_at: number;
}

/**
 * A newest-first export page: `next_before` is the created-at epoch-ms cursor to
 * pass back as `before` for the next (older) page, or null at the end.
 */
export interface BotExportPage<T> {
  object: 'list';
  data: T[];
  next_before: number | null;
}

/** limit (1..500, default 100) and an optional `before` epoch-ms cursor. */
export interface BotExportParams {
  limit?: number;
  /** created-at epoch-ms cursor; returns rows OLDER than this. */
  before?: number;
}

export interface CreateBotLabelBody {
  subject_type: 'user' | 'device' | 'ip_hash' | 'attempt';
  subject_id: string;
  label: 'bot' | 'human' | 'suspect';
  /** Clamped to 0..1; defaults to 1. */
  confidence?: number;
  note?: string;
}

/**
 * Export the anti-bot signal lake and its training labels, and let an analyst
 * add labels — the surface a tenant pulls to train their own bot-vs-human model.
 */
export function botSignalsResource(request: RequestFn) {
  return {
    /** Page the signal lake, newest first, for an incremental pull. */
    list(query?: BotExportParams): Promise<BotExportPage<BotSignal>> {
      return request({ method: 'GET', path: '/v1/bot_signals', query: { ...query } });
    },
    /** Page the training labels, newest first. */
    listLabels(query?: BotExportParams): Promise<BotExportPage<BotLabel>> {
      return request({ method: 'GET', path: '/v1/bot_labels', query: { ...query } });
    },
    /** Attach a training label to a user / device / ip_hash / attempt. */
    createLabel(body: CreateBotLabelBody, idempotencyKey?: string): Promise<BotLabel> {
      return request({ method: 'POST', path: '/v1/bot_labels', body, idempotencyKey });
    },
  };
}
