import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The transactional SMS a template drives. */
export type SmsTemplateName = 'verification_code' | 'mfa_code';

/**
 * A template row: table-backed, keyed by `name`. The built-in `default` and the
 * stored `body` override are both returned so a caller can show a diff. `body`
 * is null when no override is stored.
 */
export interface SmsTemplate {
  object: 'sms_template';
  name: SmsTemplateName;
  default: string;
  body: string | null;
  enabled: boolean;
  customised: boolean;
  variables: readonly string[];
}

export interface CreateSmsTemplateBody {
  name: string;
  body: string;
  enabled?: boolean;
}

/** A rendered body with a fixed SAMPLE code (`123456`), never a live OTP. */
export interface SmsTemplatePreview {
  object: 'sms_template_preview';
  name: SmsTemplateName;
  body: string;
  customised: boolean;
}

export function smsTemplatesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<SmsTemplate>> {
      return request({ method: 'GET', path: '/v1/sms_templates' });
    },
    /** Upsert an override by name. */
    create(body: CreateSmsTemplateBody, idempotencyKey?: string): Promise<SmsTemplate> {
      return request({ method: 'POST', path: '/v1/sms_templates', body, idempotencyKey });
    },
    get(name: string): Promise<SmsTemplate> {
      return request({ method: 'GET', path: `/v1/sms_templates/${enc(name)}` });
    },
    update(name: string, body: { body?: string; enabled?: boolean }): Promise<SmsTemplate> {
      return request({ method: 'PATCH', path: `/v1/sms_templates/${enc(name)}`, body });
    },
    /** Revert to the built-in. */
    delete(name: string): Promise<SmsTemplate> {
      return request({ method: 'DELETE', path: `/v1/sms_templates/${enc(name)}` });
    },
    /** Render an unsaved draft (if a body is given) or the stored/built-in. */
    preview(name: string, body: { body?: string } = {}): Promise<SmsTemplatePreview> {
      return request({ method: 'POST', path: `/v1/sms_templates/${enc(name)}/preview`, body });
    },
  };
}
