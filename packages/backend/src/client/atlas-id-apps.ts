import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** A Sign in with Atlas app this instance manages. */
export interface ManagedAtlasIdApp {
  object: 'atlas_id_app';
  id: string;
  client_id: string;
  name: string;
  managed_by_instance_id: string | null;
  /** `instance_toggle`: the app of this instance's own toggle. `adopted`: an app its owner handed over. */
  managed_via: 'instance_toggle' | 'adopted';
  allowed_scopes: string[];
  created_at: number;
  [field: string]: unknown;
}

/** Sign in with Atlas apps on the instance surface (a secret key with `atlas_id_grants:*`). */
export function atlasIdAppsResource(request: RequestFn) {
  return {
    /** The apps this instance manages. */
    list(): Promise<ListPage<ManagedAtlasIdApp>> {
      return request({ method: 'GET', path: '/v1/atlas_id_apps' });
    },
    /**
     * Adopt an account-level app with the one-time code its owner issued
     * (`platform.atlasIdApps.issueAdoptionCode`). No platform key is needed here.
     */
    adopt(code: string): Promise<ManagedAtlasIdApp & { changed: boolean }> {
      return request({ method: 'POST', path: '/v1/atlas_id_apps/adopt', body: { code } });
    },
    /** Hand an adopted app back to its owner. */
    release(id: string): Promise<{ object: 'atlas_id_app_release'; app_id: string; released: true }> {
      return request({ method: 'POST', path: `/v1/atlas_id_apps/${enc(id)}/release` });
    },
  };
}
