import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The surface a localization row overrides for one locale. */
export type LocalizationResourceType = 'email_template' | 'sms_template' | 'prompt_copy';

/**
 * A per-locale override the render paths resolve at send/render time. Always an
 * OVERRIDE: the base renders whenever no row matches the target locale, so a row
 * can only change a surface for one locale, never break it. Timestamps are ISO
 * strings, not epoch numbers.
 */
export interface Localization {
  object: 'localization';
  id: string;
  resource_type: LocalizationResourceType;
  resource_name: string;
  locale: string;
  content: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListLocalizationsParams {
  resource_type?: string;
  resource_name?: string;
  locale?: string;
}

export interface CreateLocalizationBody {
  resource_type: LocalizationResourceType;
  resource_name: string;
  locale: string;
  content: Record<string, unknown>;
  enabled?: boolean;
}

export function localizationsResource(request: RequestFn) {
  return {
    list(params: ListLocalizationsParams = {}): Promise<ListPage<Localization>> {
      return request({ method: 'GET', path: '/v1/localizations', query: { ...params } });
    },
    create(body: CreateLocalizationBody, idempotencyKey?: string): Promise<Localization> {
      return request({ method: 'POST', path: '/v1/localizations', body, idempotencyKey });
    },
    get(id: string): Promise<Localization> {
      return request({ method: 'GET', path: `/v1/localizations/${enc(id)}` });
    },
    update(
      id: string,
      body: { content?: Record<string, unknown>; enabled?: boolean },
    ): Promise<Localization> {
      return request({ method: 'PATCH', path: `/v1/localizations/${enc(id)}`, body });
    },
    delete(id: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/localizations/${enc(id)}` });
    },
  };
}
