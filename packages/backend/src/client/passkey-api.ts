import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ExternalPasskey {
  object: 'external_passkey';
  id: string;
  user_id: string;
  credential_id: string;
  name: string | null;
  aaguid: string | null;
  backed_up: boolean;
  transports: string[];
  last_used_at: number | null;
  created_at: number;
}

export interface PasskeyRegistrationFinalize {
  user_id: string;
  challenge: string;
  attestation_object: string;
  client_data_json: string;
  name?: string;
  transports?: string[];
}

export interface PasskeyLoginFinalize {
  handle: string;
  challenge: string;
  credential_id: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  /** Require the passkey to belong to this user. */
  user_id?: string;
}

/**
 * Passkeys for a user store you own: Atlas runs the WebAuthn ceremony, you keep
 * the users and the session. Pass `options` to navigator.credentials.create()/get().
 */
export function passkeyApiResource(request: RequestFn) {
  return {
    registrationInit(body: { user_id: string; username?: string; display_name?: string }): Promise<{ object: 'passkey_registration_options'; options: Record<string, unknown> }> {
      return request({ method: 'POST', path: '/v1/passkey_api/registration/init', body });
    },
    registrationFinalize(body: PasskeyRegistrationFinalize): Promise<ExternalPasskey> {
      return request({ method: 'POST', path: '/v1/passkey_api/registration/finalize', body });
    },
    loginInit(body: { user_id?: string } = {}): Promise<{ object: 'passkey_login_options'; handle: string; options: Record<string, unknown> }> {
      return request({ method: 'POST', path: '/v1/passkey_api/login/init', body });
    },
    loginFinalize(body: PasskeyLoginFinalize): Promise<{
      object: 'passkey_login_result';
      verified: true;
      user_id: string;
      credential_id: string;
      passkey_id: string;
      user_verified: boolean;
      cloned_warning: boolean;
    }> {
      return request({ method: 'POST', path: '/v1/passkey_api/login/finalize', body });
    },
    list(userId: string): Promise<ListPage<ExternalPasskey>> {
      return request({ method: 'GET', path: `/v1/passkey_api/users/${enc(userId)}/passkeys` });
    },
    delete(userId: string, id: string): Promise<{ object: 'external_passkey'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/passkey_api/users/${enc(userId)}/passkeys/${enc(id)}` });
    },
    usage(): Promise<{ object: 'passkey_api_usage'; passkeys: number }> {
      return request({ method: 'GET', path: '/v1/passkey_api/usage' });
    },
  };
}
