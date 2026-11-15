/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { recordAudit } from './emu4-trust';
import { engineState } from './support';

/** A payment provider's stored credentials, as `PUT /v1/billing/providers/{provider}` keeps them. */
export interface ProviderCfg {
  provider: string;
  environment: 'live' | 'test';
  status: string;
  /** Public and secret keys together; secrets never leave through a read. */
  config: Record<string, string>;
  last_verified_at: number | null;
  last_webhook_at: number | null;
  updated_at: number;
}

export const providerState = engineState((): Map<string, ProviderCfg> => new Map());
export const providerOf = (e: Engine, name: string): ProviderCfg | undefined => providerState(e).get(name);

/** The credential a provider's deliveries are verified with (the public app identity for the two stores). */
export const WEBHOOK_SECRET: Record<string, string> = { stripe: 'webhook_secret', polar: 'webhook_secret', dodo: 'webhook_secret', creem: 'webhook_secret', chargebee: 'webhook_password', autumn: 'webhook_secret', commet: 'webhook_secret', paddle: 'webhook_secret', lemonsqueezy: 'webhook_secret', revenuecat: 'webhook_secret', appstore: 'bundle_id', googleplay: 'push_audience' };

/** An audit row (named as the real service names it), listed by the audit log routes. */
export function audit(e: Engine, action: string, targetType: string, targetId: string, metadata: Obj = {}): void {
  recordAudit(e, { actor_type: 'api_key', actor_id: 'emulator_key_0', action, target_type: targetType, target_id: targetId, metadata });
}

/** A refusal with a status the shared catalogue does not give this code. */
export const withStatus = (err: EmulatorError, status: number): EmulatorError => Object.assign(err, { status });
export const bad = (message: string, param?: string): EmulatorError => new EmulatorError('VALIDATION_FAILED', message, param);
