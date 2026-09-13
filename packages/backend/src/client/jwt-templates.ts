import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface JwtTemplate {
  object: 'jwt_template';
  name: string;
  claims: Record<string, string>;
}

export interface CreateJwtTemplateBody {
  name: string;
  claims: Record<string, string>;
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
    /** Only the claims are updatable; the name is the key. */
    update(name: string, body: { claims: Record<string, string> }): Promise<JwtTemplate> {
      return request({ method: 'PATCH', path: `/v1/jwt_templates/${enc(name)}`, body });
    },
    delete(name: string): Promise<{ object: 'jwt_template'; name: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/jwt_templates/${enc(name)}` });
    },
  };
}
