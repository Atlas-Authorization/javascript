import type { RequestFn } from './request';

/**
 * The hosted-page / email appearance bag (`authConfig.branding`). Every field is
 * optional and authored by a customer; the render paths only ever read the
 * SANITIZED resolution of it, never these raw values. The flat colour/logo
 * fields feed both email and the hosted page; the deeper fields (`layout`,
 * `interaction`, `card`, …) shape the hosted page only.
 */
export interface Branding {
  applicationName?: string;
  logoUrl?: string;
  colorPrimary?: string;
  colorBackground?: string;
  colorText?: string;
  /** Shown in the email footer; falls back to the application name. */
  supportEmail?: string;

  colorAccent?: string;
  colorCard?: string;
  colorBorder?: string;
  /** A CSS length like `12px` or `0.75rem`. */
  borderRadius?: string;
  theme?: 'light' | 'dark' | 'auto';
  /** A curated stack name or `custom`. */
  fontFamily?: string;
  /** When `fontFamily === 'custom'`, an https URL to a @font-face stylesheet. */
  fontUrl?: string;
  layout?: 'centered' | 'split' | 'wall';
  background?: HostedBackground;
  /** Provider display order + which social providers to hide. */
  providers?: { order?: string[]; hidden?: string[] };
  copy?: { headline?: string; subheadline?: string; footer?: string };
  socialButtons?: {
    variant?: 'block' | 'compact' | 'icon';
    size?: 'sm' | 'md' | 'lg';
    layout?: 'list' | 'grid' | 'carousel';
    labels?: Record<string, string>;
    search?: 'auto' | 'always' | 'never';
    /** Per-provider colour overrides, keyed by provider id. */
    styles?: Record<string, { bg?: string; fg?: string }>;
  };
  /** How a verification code is entered — segmented `boxes` (default) or `single`. */
  codeInput?: 'boxes' | 'single';
  card?: {
    width?: 'narrow' | 'default' | 'wide';
    align?: 'left' | 'center';
    logoSize?: 'sm' | 'md' | 'lg';
  };
  typography?: {
    headingSize?: 'sm' | 'md' | 'lg' | 'xl';
    headingWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  };
  buttonShape?: 'default' | 'rounded' | 'pill' | 'square';
  cardBorder?: 'default' | 'none' | 'bold';
  inputSize?: 'sm' | 'md' | 'lg';
  interaction?: {
    buttonStyle?: 'solid' | 'outline' | 'soft' | 'ghost';
    buttonEffect?: 'none' | 'scale' | 'lift' | 'glow' | 'ripple';
    shadow?: 'none' | 'sm' | 'md' | 'lg';
    density?: 'comfortable' | 'compact' | 'spacious';
    inputStyle?: 'outline' | 'filled' | 'underline';
    animations?: boolean;
    motionSpeed?: 'slow' | 'normal' | 'fast';
    motionEasing?: 'ease' | 'linear' | 'smooth' | 'spring';
    loading?: 'spinner' | 'skeleton' | 'dots' | 'bar';
  };
  backgroundPattern?: 'none' | 'dots' | 'grid' | 'stripes';
  cardStyle?: 'default' | 'glass';
  textScale?: 'sm' | 'md' | 'lg';
  socialPlacement?: 'top' | 'bottom';
  /** A permutation of `['logo','heading','social','form']`. */
  sectionOrder?: string[];
  legal?: { termsUrl?: string; privacyUrl?: string; required?: boolean };
  signUpFields?: Array<{
    key?: string;
    label?: string;
    type?:
      | 'text'
      | 'email'
      | 'tel'
      | 'url'
      | 'number'
      | 'date'
      | 'textarea'
      | 'checkbox'
      | 'select'
      | 'radio'
      | 'multiselect';
    required?: boolean;
    placeholder?: string;
    options?: string[];
  }>;
  /** Raw CSS, injected after sanitization. */
  customCss?: string;
  /** Sanitized HTML slot above the card. */
  customHtmlHeader?: string;
  /** Sanitized HTML slot below the card. */
  customHtmlFooter?: string;
}

export interface HostedBackground {
  type: 'solid' | 'gradient' | 'image' | 'wall';
  color?: string;
  from?: string;
  to?: string;
  angle?: number;
  imageUrl?: string;
}

/** What the renderers actually use — everything already escaped or dropped. */
export interface ResolvedBranding {
  applicationName: string;
  escapedName: string;
  logoUrl: string | null;
  colorPrimary: string;
  colorBackground: string;
  colorText: string;
  supportEmail: string | null;
}

/**
 * A read/update echoes the stored branding plus `resolved` — the sanitized shape
 * the page will actually render, so a value silently dropped shows up here
 * rather than being discovered on a live page.
 */
export interface BrandingResponse extends Branding {
  object: 'branding';
  resolved: ResolvedBranding;
}

/** A draft rendered through the real hosted-page renderer, returned as HTML. */
export interface HostedPagePreview {
  object: 'hosted_page_preview';
  html: string;
}

export function brandingResource(request: RequestFn) {
  return {
    get(): Promise<BrandingResponse> {
      return request({ method: 'GET', path: '/v1/branding' });
    },
    /** A PARTIAL merge — one field changes, the rest is preserved. */
    update(body: Partial<Branding>): Promise<BrandingResponse> {
      return request({ method: 'PATCH', path: '/v1/branding', body });
    },
    /** Render a draft through the live sign-in renderer without saving it. */
    preview(body: Partial<Branding>): Promise<HostedPagePreview> {
      return request({ method: 'POST', path: '/v1/branding/preview', body });
    },
  };
}
