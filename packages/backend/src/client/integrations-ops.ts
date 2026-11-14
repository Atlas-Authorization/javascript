import { enc, type RequestFn } from './request';



export type IntegrationsRunCardActionBody = {
  sub: string;
  iss?: string;
  /** Who pressed the button in the integrated service (recorded in the audit log). */
  agent?: {
    id?: string;
    name?: string;
    email?: string;
  };
};

export type IntegrationsRunCardActionResult = {
  object: 'integration_card_action';
  integration: string;
  action: 'revoke_sessions';
  ok: boolean;
  sessions_revoked: number;
};

/** Operations on `/v1/integrations` (1). */
export function integrationsOpsResource(request: RequestFn) {
  return {
    /** Run a card action. revoke_sessions signs the user out of every device (their sessions end, back-channel logouts go out) and is audited with the agent the integration names. Partner link with sessions:write, or the secret key. */
    runCardAction(integration: string, action: string, body: IntegrationsRunCardActionBody, idempotencyKey?: string): Promise<IntegrationsRunCardActionResult> {
      return request({ method: 'POST', path: `/v1/integrations/${enc(integration)}/card/actions/${enc(action)}`, body, idempotencyKey });
    },
  };
}
