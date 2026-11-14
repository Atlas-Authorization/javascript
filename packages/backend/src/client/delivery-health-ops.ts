import { enc, type RequestFn } from './request';

type C_DeliveryHealth = {
  object?: 'delivery_health';
  kind?: 'webhook_endpoint' | 'referral_connection' | 'backchannel_receiver' | 'integration' | 'messaging_email' | 'messaging_sms' | 'messaging_push';
  target_id?: string;
  url?: string | null;
  label?: string | null;
  state?: 'healthy' | 'failing' | 'disabled';
  failing_since?: number | null;
  disabled_at?: number | null;
  last_success_at?: number | null;
  last_failure?: Record<string, unknown> | null;
  consecutive_failures?: number;
  success_rate_24h?: number | null;
  attempts_24h?: Record<string, unknown>;
  alert_contacts?: string[] | null;
  alerts?: Record<string, unknown>;
};

export type DeliveryHealthGetResult = C_DeliveryHealth;

/** Operations on `/v1/delivery_health` (1). */
export function deliveryHealthOpsResource(request: RequestFn) {
  return {
    /** Delivery health of one target. 404 until a delivery to it has been recorded. */
    get(kind: string, id: string): Promise<DeliveryHealthGetResult> {
      return request({ method: 'GET', path: `/v1/delivery_health/${enc(kind)}/${enc(id)}` });
    },
  };
}
