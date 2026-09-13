import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The transactional email a template drives. */
export type EmailTemplateName =
  | 'verification_code'
  | 'magic_link'
  | 'password_reset'
  | 'password_changed'
  | 'account_exists_notice'
  | 'organization_invitation'
  | 'new_device_sign_in'
  | 'session_revoked_token_reuse'
  | 'account_locked'
  | 'team_member_added'
  | 'team_role_changed';

/** The customizable body of a template: a subject line and a text body. */
export interface EmailTemplateBody {
  subject?: string;
  text?: string;
}

/**
 * A list row: the built-in `default` and the stored `override` are both returned
 * so a caller can show a diff rather than guess what changed.
 */
export interface EmailTemplate {
  object: 'email_template';
  name: EmailTemplateName;
  default: { subject: string; text: string };
  override: EmailTemplateBody | null;
  customised: boolean;
}

/** The lean shape an update/delete acknowledges with (no `default`). */
export interface EmailTemplateResult {
  object: 'email_template';
  name: EmailTemplateName;
  override: EmailTemplateBody | null;
  customised: boolean;
}

/**
 * A rendered template with SAMPLE variables (never a real code). `valid` is false
 * with a `problem` when the draft would be dropped by the renderer.
 */
export interface EmailTemplatePreview {
  object: 'email_preview';
  template: EmailTemplateName;
  valid: boolean;
  problem: string | null;
  html: string | null;
  variables: Record<string, string>;
}

export function emailTemplatesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<EmailTemplate>> {
      return request({ method: 'GET', path: '/v1/email_templates' });
    },
    /** Render an unsaved draft (if a body is given) or the stored template. */
    preview(name: string, body: EmailTemplateBody = {}): Promise<EmailTemplatePreview> {
      return request({ method: 'POST', path: `/v1/email_templates/${enc(name)}/preview`, body });
    },
    /** Save an override. Keyed by template name, not an id. */
    update(name: string, body: EmailTemplateBody): Promise<EmailTemplateResult> {
      return request({ method: 'PUT', path: `/v1/email_templates/${enc(name)}`, body });
    },
    /** Revert to the built-in. */
    delete(name: string): Promise<EmailTemplateResult> {
      return request({ method: 'DELETE', path: `/v1/email_templates/${enc(name)}` });
    },
  };
}
