import type { RequestFn } from './request';

/**
 * The instance-wide JSON Schema every organization's settings document is
 * validated against (`organizations.settings.*`). The validated subset is
 * type/required/properties/enum/minimum/maximum/minLength/maxLength/minItems/
 * maxItems/items/additionalProperties/pattern/format (email, uri/url,
 * date-time, uuid).
 */
export interface OrganizationSettingsSchema {
  object: 'organization_settings_schema';
  schema: Record<string, unknown>;
  /** Bumped each time the schema is re-registered. */
  version: number;
  /** Last registered (epoch ms). */
  updated_at: number;
}

export function organizationSettingsSchemaResource(request: RequestFn) {
  return {
    /** 404 when no schema is registered. */
    get(): Promise<OrganizationSettingsSchema> {
      return request({ method: 'GET', path: '/v1/organization_settings_schema' });
    },
    /** First registration. */
    create(
      schema: Record<string, unknown>,
      idempotencyKey?: string,
    ): Promise<OrganizationSettingsSchema> {
      return request({
        method: 'POST',
        path: '/v1/organization_settings_schema',
        body: { schema },
        idempotencyKey,
      });
    },
    /** Replace the schema; bumps `version` so consumers can detect the contract change. */
    replace(
      schema: Record<string, unknown>,
      idempotencyKey?: string,
    ): Promise<OrganizationSettingsSchema> {
      return request({
        method: 'PUT',
        path: '/v1/organization_settings_schema',
        body: { schema },
        idempotencyKey,
      });
    },
  };
}
