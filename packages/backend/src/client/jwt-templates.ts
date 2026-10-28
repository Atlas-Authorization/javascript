import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface JwtTemplate {
  object: 'jwt_template';
  name: string;
  claims: Record<string, string>;
  /** Non-secret mint settings; the HS256 secret is never returned. */
  settings?: {
    lifetime_seconds: number | null;
    audience: string | null;
    algorithm: 'RS256' | 'HS256';
    has_signing_secret: boolean;
  };
}

/**
 * Per-template mint settings. `lifetime_seconds` is 10–86400 (default: the
 * instance session-token lifetime, 60 s); null clears a value on update.
 */
export interface JwtTemplateSettingsInput {
  lifetime_seconds?: number | null;
  audience?: string | null;
  algorithm?: 'RS256' | 'HS256';
  /** HS256 shared secret, at least 16 characters. Write-only. */
  signing_secret?: string;
}

export interface CreateJwtTemplateBody {
  name: string;
  /**
   * Claim → expression. `{{org.id}}`, `{{org.membership_id}}` and `{{org.role}}`
   * resolve per session from the active organization at mint time.
   */
  claims: Record<string, string>;
  settings?: JwtTemplateSettingsInput;
}

export interface UpdateJwtTemplateBody {
  claims?: Record<string, string>;
  settings?: JwtTemplateSettingsInput;
}

export function jwtTemplatesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<JwtTemplate>> {
      return request({ method: 'GET', path: '/v1/jwt_templates' });
    },
    /** Fetched by template name. */
    get(name: string): Promise<JwtTemplate> {
      return request({ method: 'GET', path: `/v1/jwt_templates/${enc(name)}` });
    },
    create(body: CreateJwtTemplateBody): Promise<JwtTemplate> {
      return request({ method: 'POST', path: '/v1/jwt_templates', body });
    },
    /** Claims and/or settings; the name is the key and cannot change. */
    update(name: string, body: UpdateJwtTemplateBody): Promise<JwtTemplate> {
      return request({ method: 'PATCH', path: `/v1/jwt_templates/${enc(name)}`, body });
    },
    delete(name: string): Promise<{ object: 'jwt_template'; name: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/jwt_templates/${enc(name)}` });
    },
  };
}
