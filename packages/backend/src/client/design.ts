import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * The structured sign-in page design, shared by the instance's hosted pages,
 * per-organization overrides and Sign in with Atlas app pages.
 *
 * Every leaf is a closed set of values, a bounded number, a `#RRGGBB` hex colour,
 * a catalog id (preset, font) or an uploaded image id (`dasset_…`) — there is no
 * field for CSS, HTML or arbitrary URLs. A stored design is a set of OVERRIDES:
 * every section and field is optional and falls back to the chosen preset, then
 * the defaults. Unknown keys are refused by the API with their full path.
 */
export type DesignHexColor = string;

export type DesignPresetId =
  | 'minimal'
  | 'atlas'
  | 'glass'
  | 'midnight'
  | 'editorial'
  | 'terminal'
  | 'sunrise'
  | 'forest'
  | 'grape'
  | 'slate'
  | 'split-photo'
  | 'bold';

export type DesignColorScheme = 'auto' | 'light' | 'dark';

export type DesignTypeScale =
  | 'minor-second'
  | 'major-second'
  | 'minor-third'
  | 'major-third'
  | 'perfect-fourth'
  | 'augmented-fourth'
  | 'perfect-fifth'
  | 'golden'
  | 'minor-seventh'
  | 'octave';

export type DesignImagePosition =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

/** Colour slots, each a `#RRGGBB` hex. */
export interface DesignPalette {
  primary?: DesignHexColor;
  /** Text/icon colour on a primary fill (button label). */
  primaryInk?: DesignHexColor;
  accent?: DesignHexColor;
  background?: DesignHexColor;
  surface?: DesignHexColor;
  text?: DesignHexColor;
  muted?: DesignHexColor;
  border?: DesignHexColor;
  danger?: DesignHexColor;
  success?: DesignHexColor;
  inputBackground?: DesignHexColor;
  inputText?: DesignHexColor;
}

export interface DesignTypography {
  /** A font id from the design catalog (`design.catalog().fonts`). */
  font?: string;
  headingFont?: string;
  /** Body text size in px (12–20). */
  baseSize?: number;
  /** 400–800, in steps of 100. */
  headingWeight?: number;
  /** 300–600, in steps of 100. */
  bodyWeight?: number;
  /** Letter case of button labels. */
  letterCase?: 'none' | 'uppercase';
  scale?: DesignTypeScale;
}

export interface DesignShape {
  /** Card corner radius, px (0–32). */
  radius?: number;
  /** Button + input corner radius, px (0–999; 999 = pill). */
  controlRadius?: number;
  /** 0–3 px. */
  borderWidth?: number;
}

export interface DesignElevation {
  cardShadow?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
}

export interface DesignSpacing {
  density?: 'compact' | 'comfortable' | 'spacious';
}

export interface DesignCard {
  style?: 'solid' | 'glass' | 'outline' | 'none';
  /** Backdrop blur, px (0–40). Only applied when `style` is `glass`. */
  blur?: number;
  width?: 'narrow' | 'normal' | 'wide';
}

export interface DesignLayout {
  position?: 'center' | 'left' | 'right' | 'split';
  /** Which side the image panel sits on. Only applied when `position` is `split`. */
  splitImageSide?: 'left' | 'right';
  /** `hidden` is refused on Sign in with Atlas app pages. */
  logoPlacement?: 'card' | 'page' | 'hidden';
  logoSize?: 'sm' | 'md' | 'lg';
}

export interface DesignButtons {
  style?: 'solid' | 'outline' | 'soft' | 'gradient';
  socialLayout?: 'list' | 'grid' | 'icons';
}

export interface DesignInputs {
  style?: 'outline' | 'filled' | 'underline';
}

export interface DesignGradient {
  type: 'linear' | 'radial';
  /** Degrees (0–360); linear only. */
  angle?: number;
  /** 2–4 stops; `at` is a percentage (0–100). */
  stops: Array<{ color: DesignHexColor; at: number }>;
}

export interface DesignBackgroundImage {
  /** An uploaded background image (`dasset_…`). */
  assetId: string;
  fit?: 'cover' | 'contain';
  position?: DesignImagePosition;
  /** `opacity` is 0–1. */
  overlay?: { color: DesignHexColor; opacity: number };
  /** 0–20 px. */
  blur?: number;
}

/**
 * A page background: a colour, a gradient, an uploaded image and a pattern,
 * painted bottom to top. Setting `background` replaces the preset's background
 * as a whole.
 */
export interface DesignBackground {
  color?: DesignHexColor;
  gradient?: DesignGradient;
  image?: DesignBackgroundImage;
  pattern?: 'none' | 'dots' | 'grid' | 'noise';
}

export interface DesignLogo {
  /** Uploaded logo for light mode (`dasset_…`). */
  assetId?: string;
  /** Uploaded logo for dark mode; falls back to `assetId`. */
  darkAssetId?: string;
}

/** A stored design: overrides on top of a preset. Every field is optional. */
export interface AtlasDesign {
  version?: 1;
  preset?: DesignPresetId;
  colorScheme?: DesignColorScheme;
  palette?: DesignPalette;
  paletteDark?: DesignPalette;
  typography?: DesignTypography;
  shape?: DesignShape;
  elevation?: DesignElevation;
  spacing?: DesignSpacing;
  card?: DesignCard;
  layout?: DesignLayout;
  buttons?: DesignButtons;
  inputs?: DesignInputs;
  background?: DesignBackground;
  backgroundDark?: DesignBackground;
  logo?: DesignLogo;
}

type DeepPatch<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends readonly unknown[]
    ? T[K] | null
    : NonNullable<T[K]> extends object
      ? DeepPatch<NonNullable<T[K]>> | null
      : T[K] | null;
};

/**
 * A partial design update: nested objects merge, arrays (gradient stops) and
 * values replace, and `null` removes a setting (falling back to the preset).
 */
export type AtlasDesignPatch = DeepPatch<AtlasDesign>;

/** The fully resolved design every surface renders (defaults ← preset ← overrides). */
export interface ResolvedAtlasDesign {
  version: 1;
  preset: DesignPresetId;
  colorScheme: DesignColorScheme;
  palette: Required<DesignPalette>;
  paletteDark: Required<DesignPalette>;
  typography: Required<DesignTypography>;
  shape: Required<DesignShape>;
  elevation: Required<DesignElevation>;
  spacing: Required<DesignSpacing>;
  card: Required<DesignCard>;
  layout: Required<DesignLayout>;
  buttons: Required<DesignButtons>;
  inputs: Required<DesignInputs>;
  background: DesignBackground;
  backgroundDark: DesignBackground;
  logo: DesignLogo;
}

/** A colour pair that fails its contrast target. */
export interface DesignWarning {
  code: 'low_contrast';
  mode: 'light' | 'dark';
  pair: string[];
  ratio: number;
  required: number;
  /** The setting to change, e.g. `palette.primaryInk`. */
  path: string;
  message: string;
}

/** A stored design (instance or organization) with its resolved result. */
export interface DesignSettings {
  object: 'design' | 'organization_design';
  /** Organization designs only. */
  organization_id?: string;
  design: AtlasDesign;
  resolved: ResolvedAtlasDesign;
  warnings: DesignWarning[];
  /** True when nothing is stored and the page is drawn from the older branding settings. */
  legacy: boolean;
  /** When `legacy`: the design derived from the older branding settings. */
  legacy_design?: AtlasDesign | null;
}

/** A compiled, unsaved design. Nothing is stored. */
export interface DesignPreview {
  object: 'design_preview';
  /** The selector the CSS is scoped to: `.atlas-root`. */
  scope: string;
  /** CSS custom properties (`--atlas-*`) for the scope, including light/dark blocks. */
  css: string;
  /** Attributes to set on the scoped element (`data-atlas-layout`, …). */
  data_attributes: Record<string, string>;
  /** Absolute URLs of the self-hosted font stylesheets to link. */
  font_stylesheets: string[];
  resolved: ResolvedAtlasDesign;
  warnings: DesignWarning[];
  /** The sign-in page rendered with the draft design (inert, for a sandboxed frame). */
  html: string;
}

export type DesignAssetKind = 'background' | 'logo';

/** An uploaded design image. Use `asset_id` in a design (`logo.assetId`, …). */
export interface DesignAsset {
  object: 'design_asset';
  /** `dasset_…` */
  asset_id: string;
  kind: DesignAssetKind;
  /** Where Atlas serves the stored image. */
  url: string;
  width: number;
  height: number;
  /** `#rrggbb` for an opaque image, else null. */
  dominant_color: string | null;
  /** Size of the stored (WebP) image. */
  bytes: number;
  created_at: string;
}

export interface DeletedDesignAsset {
  object: 'design_asset';
  asset_id: string;
  deleted: true;
}

/** Image bytes to upload: PNG, JPEG, GIF or WebP, up to 8 MB and 40 megapixels. */
export type DesignAssetData = Blob | ArrayBuffer | ArrayBufferView;

export interface UploadDesignAssetOptions {
  /** What the image is for (default `background`). */
  kind?: DesignAssetKind;
  /** e.g. `image/png`. Required unless `data` is a Blob with a type. */
  contentType?: string;
}

/** The public design-system catalog: presets, curated fonts and CSS variables. */
export interface DesignCatalog {
  object: 'design_catalog';
  version: 1;
  presets: Array<{
    id: DesignPresetId;
    label: string;
    description: string;
    resolved: ResolvedAtlasDesign;
  }>;
  fonts: Array<{
    id: string;
    label: string;
    family: string | null;
    category: string;
    web_font: boolean;
    stylesheet: string | null;
  }>;
  css_variables: Array<{
    name: string;
    type: string;
    perMode?: boolean;
    description: string;
  }>;
}

export function designResource(request: RequestFn) {
  return {
    /** The instance's sign-in page design: stored overrides, resolved design, warnings. */
    get(): Promise<DesignSettings> {
      return request({ method: 'GET', path: '/v1/instance/design' });
    },
    /** Replace the whole instance design. */
    replace(design: AtlasDesign): Promise<DesignSettings> {
      return request({ method: 'PUT', path: '/v1/instance/design', body: { design } });
    },
    /** Change part of the instance design; `null` removes a setting. */
    update(design: AtlasDesignPatch): Promise<DesignSettings> {
      return request({ method: 'PATCH', path: '/v1/instance/design', body: { design } });
    },
    /** Compile an unsaved design (CSS, attributes, fonts, rendered page). Nothing is saved. */
    preview(design: AtlasDesign): Promise<DesignPreview> {
      return request({ method: 'POST', path: '/v1/instance/design/preview', body: { design } });
    },
    /** Per-organization design overrides, layered over the instance design. */
    organizations: {
      get(organizationId: string): Promise<DesignSettings> {
        return request({
          method: 'GET',
          path: `/v1/organizations/${enc(organizationId)}/design`,
        });
      },
      /** Replace the override; `{}` removes it. */
      replace(organizationId: string, design: AtlasDesign): Promise<DesignSettings> {
        return request({
          method: 'PUT',
          path: `/v1/organizations/${enc(organizationId)}/design`,
          body: { design },
        });
      },
      update(organizationId: string, design: AtlasDesignPatch): Promise<DesignSettings> {
        return request({
          method: 'PATCH',
          path: `/v1/organizations/${enc(organizationId)}/design`,
          body: { design },
        });
      },
    },
    /** The instance's uploaded design images. */
    assets: {
      /**
       * Upload a background or logo image as raw bytes. Atlas checks it,
       * re-encodes it as WebP and serves it.
       */
      upload(data: DesignAssetData, options: UploadDesignAssetOptions = {}): Promise<DesignAsset> {
        return request({
          method: 'POST',
          path: '/v1/design/assets',
          query: { kind: options.kind },
          rawBody: { data, contentType: options.contentType },
        });
      },
      /** Newest first (up to 100). */
      list(): Promise<ListPage<DesignAsset>> {
        return request({ method: 'GET', path: '/v1/design/assets' });
      },
      /** Refused with 409 (`meta.used_by`) while a saved design still uses it. */
      delete(assetId: string): Promise<DeletedDesignAsset> {
        return request({ method: 'DELETE', path: `/v1/design/assets/${enc(assetId)}` });
      },
    },
    /** The public catalog: presets (resolved), curated fonts, the CSS variable set. */
    catalog(): Promise<DesignCatalog> {
      return request({ method: 'GET', path: '/v1/design/catalog' });
    },
  };
}
