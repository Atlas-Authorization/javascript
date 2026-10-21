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
  copy?: { eyebrow?: string; headline?: string; subheadline?: string; footer?: string };
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
  /**
   * Per-audience branding for the hosted pages, keyed by audience hint
   * (`[a-z0-9_-]{1,32}`, at most 20). A sign-in started with
   * `audience_hint=<hint>` uses that entry. An update merges per hint: an entry
   * replaces that hint, `null` deletes it, `audiences: null` removes them all.
   */
  audiences?: Record<string, BrandingAudience | null> | null;
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

/** The hosted-page branding for one audience hint. */
export interface BrandingAudience {
  /** Replaces the card heading (up to 120 characters). */
  heading?: string;
  /** Replaces the line under the heading (up to 240 characters). */
  subheading?: string;
  /** Replaces the logo (https). */
  logoUrl?: string;
  /** Replaces the primary colour (hex, rgb() or a CSS colour name). */
  primaryColor?: string;
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
  // Every writable field, under its input name, with the value in force (a
  // field you did not set shows its default). Optional in the type so older
  // servers still type-check; current servers always send them.
  colorAccent?: string;
  colorCard?: string;
  colorBorder?: string;
  borderRadius?: string;
  theme?: 'light' | 'dark' | 'auto';
  /** The font stack name in force (`system` when unset or unknown). */
  fontFamily?: string;
  /** The CSS font-family list `fontFamily` resolves to. */
  fontStack?: string;
  fontUrl?: string | null;
  layout?: 'centered' | 'split' | 'wall';
  background?: Record<string, unknown>;
  providers?: { order: string[]; hidden: string[] };
  providerOrder?: string[];
  providerHidden?: string[];
  socialButtons?: Record<string, unknown>;
  codeInput?: 'boxes' | 'single';
  /** Every audience the hosted page can theme for, as it reads them (invalid values dropped). */
  audiences?: Record<string, BrandingAudience>;
  card?: { width: string; align: string; logoSize: string };
  typography?: { headingSize: string; headingWeight: string };
  buttonShape?: string;
  cardBorder?: string;
  inputSize?: string;
  interaction?: Record<string, unknown>;
  backgroundPattern?: string;
  cardStyle?: string;
  textScale?: string;
  socialPlacement?: 'top' | 'bottom';
  sectionOrder?: string[];
  legal?: { termsUrl: string | null; privacyUrl: string | null; required: boolean };
  signUpFields?: Array<Record<string, unknown>>;
  copy?: { eyebrow: string | null; headline: string | null; subheadline: string | null; footer: string | null };
  eyebrow?: string | null;
  headline?: string | null;
  subheadline?: string | null;
  footer?: string | null;
  customCss?: string;
  customHtmlHeader?: string;
  customHtmlFooter?: string;
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
