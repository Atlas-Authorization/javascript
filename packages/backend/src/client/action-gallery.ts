import { enc, type RequestFn } from './request';
import type { Action, ActionTrigger } from './actions';
import type { ListPage } from './types';

/**
 * §actions gallery — browse reusable Action templates (first-party and
 * community), install one into the instance as a DISABLED action, keep installed
 * actions up to date, and publish your own templates for review.
 */

/** Every trigger a template can target (a superset of the classic three). */
export type GalleryTrigger = ActionTrigger;

/** A secret a template reads, declared by NAME; values are never part of a template. */
export interface ActionTemplateSecret {
  name: string;
  description: string;
  required: boolean;
}

export interface ActionGalleryEntry {
  object: 'action_template';
  source: 'builtin' | 'community';
  slug: string;
  name: string;
  summary: string;
  trigger: GalleryTrigger;
  category: string;
  tags: string[];
  /** SPDX licence id. */
  license: string;
  author: { name: string; first_party: boolean };
  verified: boolean;
  featured: boolean;
  install_count: number;
  latest_version: string;
  /** The code sends outbound requests with `api.http`. */
  uses_http: boolean;
  secrets: ActionTemplateSecret[];
  updated_at: number | null;
}

export interface ActionGalleryDetail extends ActionGalleryEntry {
  /** Markdown. */
  description: string;
  code: string;
  changelog: string | null;
  repository_url: string | null;
  versions: Array<{ version: string; changelog: string | null; released_at: number | null }>;
}

export interface ActionGalleryFilter {
  q?: string;
  category?: string;
  trigger?: GalleryTrigger;
  source?: 'builtin' | 'community';
}

export interface InstallTemplateBody {
  /** A specific approved version (default: the latest). */
  version?: string;
  /** The action's name (default: the template's). */
  name?: string;
  /** Values for the secrets the template declares. Write-only. */
  secrets?: Record<string, string>;
}

export interface ActionGalleryInstallResult {
  object: 'action_gallery_install';
  /** The new action: disabled and not bound to any flow yet. */
  action: Action;
  template: { slug: string; source: 'builtin' | 'community'; version: string };
  install_id: string;
  /** Required secrets you have not supplied yet. */
  missing_secrets: string[];
}

export interface ActionGalleryInstallation {
  object: 'action_gallery_installation';
  action_id: string;
  action_name: string;
  enabled: boolean;
  trigger: string;
  source: 'builtin' | 'community';
  template_slug: string;
  installed_version: string;
  latest_version: string | null;
  update_available: boolean;
  missing_secrets: string[];
  update_requires_secrets: string[];
  installed_at: number;
  updated_at: number;
}

export interface ActionGalleryUpdateResult {
  object: 'action_gallery_update';
  /** false when the action already runs the latest version. */
  updated: boolean;
  action: Action;
  from_version?: string;
  version: string;
}

export type ActionTemplateStatus = 'draft' | 'in_review' | 'published' | 'unlisted' | 'rejected' | 'banned';

export interface ActionTemplateVersion {
  object: 'action_template_version';
  version: string;
  status: 'draft' | 'pending_review' | 'approved' | 'rejected';
  trigger: GalleryTrigger;
  secrets: ActionTemplateSecret[];
  changelog: string | null;
  /** Why staff rejected it, when they did. */
  review_note: string | null;
  code: string;
  submitted_at: number | null;
  reviewed_at: number | null;
  created_at: number;
}

/** A template this instance publishes. */
export interface ActionTemplate {
  object: 'action_template';
  id: string;
  slug: string;
  name: string;
  author_name: string;
  summary: string;
  description: string | null;
  category: string;
  tags: string[];
  trigger: GalleryTrigger;
  license: string;
  repository_url: string | null;
  status: ActionTemplateStatus;
  latest_version: string | null;
  verified: boolean;
  featured: boolean;
  install_count: number;
  view_count: number;
  published_at: number | null;
  created_at: number;
  updated_at: number;
  versions: ActionTemplateVersion[];
}

export interface ActionTemplateListing {
  slug?: string;
  name?: string;
  /** Shown as the author on the gallery. */
  author_name?: string;
  summary?: string;
  /** Markdown. */
  description?: string;
  category?: string;
  tags?: string[];
  trigger?: GalleryTrigger;
  /** SPDX id (MIT, Apache-2.0, BSD-3-Clause, ISC, MPL-2.0, …). */
  license?: string;
  repository_url?: string | null;
}

export interface NewTemplateVersion {
  /** MAJOR.MINOR.PATCH, higher than every existing version. */
  version: string;
  code: string;
  secrets?: ActionTemplateSecret[];
  changelog?: string;
  /** Send to review right away. */
  submit?: boolean;
}

export interface CreateActionTemplateBody extends ActionTemplateListing {
  slug: string;
  name: string;
  author_name: string;
  trigger: GalleryTrigger;
  /** Optionally the first version in the same call. */
  version?: string;
  code?: string;
  secrets?: ActionTemplateSecret[];
  changelog?: string;
  submit?: boolean;
}

export function actionGalleryResource(request: RequestFn) {
  return {
    /** The gallery, best first. */
    list(filter: ActionGalleryFilter = {}): Promise<ListPage<ActionGalleryEntry>> {
      return request({ method: 'GET', path: '/v1/action_gallery', query: { ...filter } });
    },
    /** One template with its code, secret names and versions. */
    get(slug: string): Promise<ActionGalleryDetail> {
      return request({ method: 'GET', path: `/v1/action_gallery/${enc(slug)}` });
    },
    /** Install as a new, disabled action. Supply secrets, bind it, then enable it. */
    install(slug: string, body: InstallTemplateBody = {}, idempotencyKey?: string): Promise<ActionGalleryInstallResult> {
      return request({ method: 'POST', path: `/v1/action_gallery/${enc(slug)}/install`, body, idempotencyKey });
    },
    /** Actions installed from the gallery, with update status. */
    installs(): Promise<ListPage<ActionGalleryInstallation>> {
      return request({ method: 'GET', path: '/v1/action_gallery_installs' });
    },
    /** Move an installed action to its template's latest version. */
    update(actionId: string, body: { secrets?: Record<string, string> } = {}): Promise<ActionGalleryUpdateResult> {
      return request({ method: 'POST', path: `/v1/actions/${enc(actionId)}/gallery_update`, body });
    },
  };
}

export function actionTemplatesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<ActionTemplate>> {
      return request({ method: 'GET', path: '/v1/action_templates' });
    },
    create(body: CreateActionTemplateBody, idempotencyKey?: string): Promise<ActionTemplate> {
      return request({ method: 'POST', path: '/v1/action_templates', body, idempotencyKey });
    },
    get(id: string): Promise<ActionTemplate> {
      return request({ method: 'GET', path: `/v1/action_templates/${enc(id)}` });
    },
    update(id: string, body: ActionTemplateListing): Promise<ActionTemplate> {
      return request({ method: 'PATCH', path: `/v1/action_templates/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'action_template'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/action_templates/${enc(id)}` });
    },
    addVersion(id: string, body: NewTemplateVersion): Promise<ActionTemplateVersion> {
      return request({ method: 'POST', path: `/v1/action_templates/${enc(id)}/versions`, body });
    },
    submitVersion(id: string, version: string): Promise<ActionTemplateVersion> {
      return request({ method: 'POST', path: `/v1/action_templates/${enc(id)}/versions/${enc(version)}/submit` });
    },
    deleteVersion(id: string, version: string): Promise<{ object: 'action_template_version'; version: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/action_templates/${enc(id)}/versions/${enc(version)}` });
    },
    /** List an approved template again after unlisting it. */
    publish(id: string): Promise<ActionTemplate> {
      return request({ method: 'POST', path: `/v1/action_templates/${enc(id)}/publish` });
    },
    /** Hide a template from the gallery (installs keep working). */
    unlist(id: string): Promise<ActionTemplate> {
      return request({ method: 'POST', path: `/v1/action_templates/${enc(id)}/unlist` });
    },
  };
}
