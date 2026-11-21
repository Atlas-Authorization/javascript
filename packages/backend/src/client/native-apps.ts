import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** A registered native (iOS / Android) app and the callback URLs a sign-in may return to. */
export interface NativeApp {
  object: 'native_app';
  /** `napp_...`: the `native_app_id` of a sign-in start and the `X-Atlas-App-Id` header. */
  id: string;
  platform: 'ios' | 'android';
  bundle_id?: string;
  team_id?: string;
  package_name?: string;
  sha256_cert_fingerprints?: string[];
  callback_urls: string[];
  /** Epoch ms. */
  created_at: number;
}

export interface NativeAppInput {
  platform: 'ios' | 'android';
  /** ios. */
  bundle_id?: string;
  /** ios. */
  team_id?: string;
  /** android. */
  package_name?: string;
  /** android: 64 hex characters each, colons optional. */
  sha256_cert_fingerprints?: string[];
  /** 1 to 10: https (Universal / App Links) or an app-specific private-use scheme. */
  callback_urls: string[];
}

export function nativeAppsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<NativeApp>> {
      return request({ method: 'GET', path: '/v1/native_apps' });
    },
    get(id: string): Promise<NativeApp> {
      return request({ method: 'GET', path: `/v1/native_apps/${enc(id)}` });
    },
    /** Register an app. An ios app needs `bundle_id` and `team_id`; an android app `package_name` and `sha256_cert_fingerprints`. */
    create(input: NativeAppInput, idempotencyKey?: string): Promise<NativeApp> {
      return request({ method: 'POST', path: '/v1/native_apps', body: input, idempotencyKey });
    },
    /** Change an app; `callback_urls` is replaced as a whole. The platform cannot change. */
    update(id: string, patch: Partial<NativeAppInput>, idempotencyKey?: string): Promise<NativeApp> {
      return request({ method: 'PATCH', path: `/v1/native_apps/${enc(id)}`, body: patch, idempotencyKey });
    },
    delete(id: string): Promise<{ object: 'native_app'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/native_apps/${enc(id)}` });
    },
    /** Which registered apps may use the publishable key (empty = any). */
    getPublishableKeyRestriction(): Promise<{ object: 'native_app_key_restriction'; app_ids: string[] }> {
      return request({ method: 'GET', path: '/v1/native_apps/publishable_key' });
    },
    /** Restrict the publishable key to these apps; an empty list removes the restriction. */
    setPublishableKeyRestriction(appIds: string[], idempotencyKey?: string): Promise<{ object: 'native_app_key_restriction'; app_ids: string[] }> {
      return request({ method: 'PUT', path: '/v1/native_apps/publishable_key', body: { app_ids: appIds }, idempotencyKey });
    },
  };
}
