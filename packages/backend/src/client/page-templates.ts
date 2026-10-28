import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type PageTemplatePage = 'sign-in' | 'sign-up' | 'user-profile';
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
    list(): Promise<ListPage<PageTemplate>> {
      return request({ method: 'GET', path: '/v1/instance/page_templates' });
    },
    get(page: PageTemplatePage): Promise<PageTemplate> {
      return request({ method: 'GET', path: `/v1/instance/page_templates/${enc(page)}` });
    },
    /** Save the page's draft. The live page is unchanged until you promote. */
    saveDraft(page: PageTemplatePage, definition: PageTemplateDefinition): Promise<PageTemplate> {
      return request({ method: 'PUT', path: `/v1/instance/page_templates/${enc(page)}`, body: { definition } });
    },
    /** A signed link (one hour) to the hosted page with the draft applied. */
    preview(page: PageTemplatePage): Promise<PageTemplatePreview> {
      return request({ method: 'POST', path: `/v1/instance/page_templates/${enc(page)}/preview` });
    },
    /** Make the draft the live template. */
    promote(page: PageTemplatePage): Promise<PageTemplate> {
      return request({ method: 'POST', path: `/v1/instance/page_templates/${enc(page)}/promote` });
    },
    /** Drop the draft, or take the live template down. */
    discard(page: PageTemplatePage, status: 'draft' | 'live'): Promise<PageTemplate> {
      return request({ method: 'DELETE', path: `/v1/instance/page_templates/${enc(page)}`, query: { status } });
    },
  };
}
