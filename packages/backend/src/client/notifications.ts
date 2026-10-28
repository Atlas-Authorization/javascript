import { enc, type RequestFn } from './request';

/** Built-in notification templates `send` falls back to when no tenant template has the name. */
export type BuiltInNotificationTemplate =
  | 'new_device'
  | 'unattended_access'
  | 'password_changed'
  | 'mfa_changed'
  | 'email_changed'
  | 'phone_changed'
  | 'identity_linked'
  | 'identity_unlinked'
  | 'passkey_added'
  | 'passkey_removed'
  | 'recovery_codes_regenerated'
  | 'factor_removed'
  | 'device_key_added'
  | 'device_key_removed'
  | 'risk_alert';

export interface SendNotificationBody {
  /** The end-user to notify. */
  user_id: string;
  /** A template name you defined, or a built-in one. */
  template: BuiltInNotificationTemplate | (string & {});
  /** Variables interpolated into the template (e.g. device, location, when, url). */
  data?: Record<string, string>;
}

/** `suppressed` when the user opted out of the template's (optional) category. */
export interface SentNotification {
  object: 'notification';
  id: string;
  status: 'sent' | 'suppressed';
}

/** A category you defined; users can turn it off on their preference page. */
export interface NotificationCategory {
  object: 'notification_category';
  id: string;
  /** The key templates and preferences reference. */
  key: string;
  /** The user-facing label on the preference toggle. */
  label: string;
  /** Always true for a tenant-defined category. */
  optional: boolean;
  created_at: number;
}

export interface NotificationTemplate {
  object: 'notification_template';
  id: string;
  /** The `template` a send passes. */
  name: string;
  subject: string;
  /** Body with `{{variables}}` interpolated at send. */
  body: string;
  /** The category whose per-user preference gates this template. */
  category: string;
  created_at: number;
  updated_at: number;
}

export interface UpdateNotificationTemplateBody {
  subject: string;
  /** Email body with `{{variables}}`. */
  body: string;
  /** A built-in category (new_device, unattended_access, credential_change) or one you defined. */
  category: string;
}

export interface CreateNotificationTemplateBody extends UpdateNotificationTemplateBody {
  /** Unique per instance. */
  name: string;
}

export function notificationsResource(request: RequestFn) {
  return {
    /** Send a templated, instance-branded security email, honouring the user's preferences. */
    send(body: SendNotificationBody, idempotencyKey?: string): Promise<SentNotification> {
      return request({ method: 'POST', path: '/v1/notifications', body, idempotencyKey });
    },
    categories: {
      list(): Promise<{ object: 'list'; data: NotificationCategory[] }> {
        return request({ method: 'GET', path: '/v1/notification_categories' });
      },
      /** A duplicate or built-in key is a 409. */
      create(body: { key: string; label: string }): Promise<NotificationCategory> {
        return request({ method: 'POST', path: '/v1/notification_categories', body });
      },
      update(key: string, body: { label: string }): Promise<NotificationCategory> {
        return request({
          method: 'PUT',
          path: `/v1/notification_categories/${enc(key)}`,
          body,
        });
      },
      /** Refused with a 409 while a template still uses it. */
      delete(
        key: string,
      ): Promise<{ object: 'notification_category'; key: string; deleted: boolean }> {
        return request({ method: 'DELETE', path: `/v1/notification_categories/${enc(key)}` });
      },
    },
    templates: {
      list(): Promise<{ object: 'list'; data: NotificationTemplate[] }> {
        return request({ method: 'GET', path: '/v1/notification_templates' });
      },
      /** A duplicate name is a 409. */
      create(body: CreateNotificationTemplateBody): Promise<NotificationTemplate> {
        return request({ method: 'POST', path: '/v1/notification_templates', body });
      },
      get(name: string): Promise<NotificationTemplate> {
        return request({ method: 'GET', path: `/v1/notification_templates/${enc(name)}` });
      },
      update(name: string, body: UpdateNotificationTemplateBody): Promise<NotificationTemplate> {
        return request({
          method: 'PUT',
          path: `/v1/notification_templates/${enc(name)}`,
          body,
        });
      },
      delete(
        name: string,
      ): Promise<{ object: 'notification_template'; name: string; deleted: boolean }> {
        return request({ method: 'DELETE', path: `/v1/notification_templates/${enc(name)}` });
      },
    },
  };
}
