import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The sign-in, sign-up and account pages; `mfa`, `reset` and `verify` are the sign-in steps (their template replaces the page's while the step shows); `consent` and `device` are the OAuth pages. */
export type PageTemplatePage = 'sign-in' | 'sign-up' | 'user-profile' | 'mfa' | 'reset' | 'verify' | 'consent' | 'device';

/**
 * Who a template is for. None: the instance-wide template. A page draws the most specific live one, in this
 * order: the client's for the visitor's language, the client's, the organization's for the language, the
 * organization's, the instance's for the language, the instance's. `locale` alone is the instance's template for
 * one language. A language matches by its exact tag, then by its base language.
 */
export interface PageTemplateAudience {
  /** The OAuth client's public id. Not with `organization_id`. */
  client_id?: string;
  organization_id?: string;
  /** A language tag such as `fr` or `pt-BR`. */
  locale?: string;
}
export type TemplateTone = 'default' | 'muted' | 'accent' | 'success' | 'danger';
type Align = 'left' | 'center' | 'right';

/** One component. Strings are escaped; links are https, mailto: or a path; there is no raw HTML, CSS or script. */
export type TemplateNode =
  | { type: 'heading'; text: string; level?: 2 | 3; align?: Align }
  | { type: 'text'; text: string; tone?: TemplateTone; size?: 'sm' | 'md'; align?: Align }
  | { type: 'image'; src?: string; asset_id?: string; alt: string; width?: number; align?: Align }
  | { type: 'link'; label: string; href: string }
  | { type: 'button_link'; label: string; href: string }
  | { type: 'list'; items: string[] }
  | { type: 'divider' }
  | { type: 'spacer'; size?: 'sm' | 'md' | 'lg' }
  | { type: 'columns'; columns: TemplateNode[][] };

export interface PageTemplateDefinition {
  version?: 1;
  regions: Partial<Record<'header' | 'above_form' | 'below_form' | 'footer', TemplateNode[]>>;
}

export interface PageTemplateSlot {
  version: number;
  updated_at: number;
  definition: PageTemplateDefinition;
}

export interface PageTemplate {
  object: 'page_template';
  page: PageTemplatePage;
  scope: { type: 'instance' | 'client' | 'org'; id: string | null };
  /** The language it is for; null = every language. */
  locale: string | null;
  live: PageTemplateSlot | null;
  draft: PageTemplateSlot | null;
}

export interface PageTemplatePreview {
  object: 'page_template_preview';
  page: PageTemplatePage;
  url: string;
  expires_at: number;
}

export function pageTemplatesResource(request: RequestFn) {
  return {
    /** Every page's instance-wide template, then one entry per other audience that has one; `audience` returns only that audience's pages. */
    list(audience?: PageTemplateAudience): Promise<ListPage<PageTemplate>> {
      return request({ method: 'GET', path: '/v1/instance/page_templates', query: audience ? { ...audience } : undefined });
    },
    get(page: PageTemplatePage, audience?: PageTemplateAudience): Promise<PageTemplate> {
      return request({ method: 'GET', path: `/v1/instance/page_templates/${enc(page)}`, query: audience ? { ...audience } : undefined });
    },
    /** Save the page's draft. The live page is unchanged until you promote. */
    saveDraft(page: PageTemplatePage, definition: PageTemplateDefinition, audience?: PageTemplateAudience): Promise<PageTemplate> {
      return request({ method: 'PUT', path: `/v1/instance/page_templates/${enc(page)}`, body: { definition }, query: audience ? { ...audience } : undefined });
    },
    /** A signed link (one hour) to the hosted page with the draft applied. It names the audience and unlocks only that one. */
    preview(page: PageTemplatePage, audience?: PageTemplateAudience): Promise<PageTemplatePreview> {
      return request({ method: 'POST', path: `/v1/instance/page_templates/${enc(page)}/preview`, query: audience ? { ...audience } : undefined });
    },
    /** Make the draft the live template. */
    promote(page: PageTemplatePage, audience?: PageTemplateAudience): Promise<PageTemplate> {
      return request({ method: 'POST', path: `/v1/instance/page_templates/${enc(page)}/promote`, query: audience ? { ...audience } : undefined });
    },
    /** Drop the draft, or take the live template down (the page then draws the next template in the chain). */
    discard(page: PageTemplatePage, status: 'draft' | 'live', audience?: PageTemplateAudience): Promise<PageTemplate> {
      return request({ method: 'DELETE', path: `/v1/instance/page_templates/${enc(page)}`, query: { ...audience, status } });
    },
  };
}
