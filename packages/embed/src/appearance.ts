/**
 * The widget's theming model, mirroring the React SDK's appearance system
 * (packages/react/src/appearance.ts) but for a framework-agnostic custom
 * element: design tokens become CSS custom properties on the widget root, and
 * per-element class overrides are APPENDED to ours so a tenant's `class` makes
 * a rounder button rather than an unstyled one.
 *
 * Two sources feed it:
 *   - the tenant's PUBLIC appearance, fetched from `GET /v1/appearance` — the
 *     same resolved/sanitised branding the hosted page uses, minus anything
 *     that is not safe to hand a third-party origin (see the endpoint).
 *   - an inline `appearance` option the embedding page passes, which wins.
 */

/** Design tokens a tenant (or the inline override) can set. */
export interface DesignTokens {
  colorPrimary?: string;
  colorText?: string;
  colorBackground?: string;
  colorAccent?: string;
  colorCard?: string;
  colorBorder?: string;
  borderRadius?: string;
  fontFamily?: string;
}

/** Every element a page may target with an appended class. */
export type ElementKey =
  | 'root'
  | 'card'
  | 'title'
  | 'subtitle'
  | 'field'
  | 'label'
  | 'input'
  | 'error'
  | 'buttonPrimary'
  | 'socialButton'
  | 'divider'
  | 'footer';

/**
 * How the social sign-in buttons are drawn — the knobs a page opens up so a
 * tenant can make them their own without writing CSS.
 *
 *   variant — `block` is the full "Continue with Google" bar (default); `compact`
 *     is the brand mark + short name ("Google"); `icon` is the mark alone (great
 *     for a dense grid or carousel of many providers).
 *   size    — button height/scale: `sm` | `md` (default) | `lg`.
 *   layout  — `list` stacks them (default); `grid` wraps them into rows;
 *     `carousel` is a single swipeable, scroll-snapped row.
 *   labels  — per-provider text override, e.g. `{ github: 'Sign in with GitHub' }`.
 *     Ignored by the `icon` variant, where the name becomes the tooltip / a11y label.
 *   search  — a filter box above the buttons so a user can type to narrow a long
 *     provider list. `auto` (default) shows it only once there are more than
 *     {@link SEARCH_AUTO_THRESHOLD} social providers — so a handful stays clean but
 *     a wall of 20 becomes searchable; `always` forces it; `never` hides it.
 */
export type SocialButtonVariant = 'block' | 'compact' | 'icon';
export type SocialButtonSize = 'sm' | 'md' | 'lg';
export type SocialButtonLayout = 'list' | 'grid' | 'carousel';
export type SocialButtonSearch = 'auto' | 'always' | 'never';

/**
 * How a verification code (email code, 2FA) is entered. `boxes` (default) is the
 * segmented one-box-per-digit input that auto-advances and accepts a paste;
 * `single` is one plain text field. Purely presentational — both submit the same
 * `code`.
 */
export type CodeInputStyle = 'boxes' | 'single';
const CODE_INPUT_STYLES: readonly CodeInputStyle[] = ['boxes', 'single'];

/** Resolve the code-input style: inline override wins, then server, then `boxes`. */
export function resolveCodeInput(
  server: CodeInputStyle | undefined,
  inline: CodeInputStyle | undefined,
): CodeInputStyle {
  for (const v of [inline, server]) if (v && CODE_INPUT_STYLES.includes(v)) return v;
  return 'boxes';
}

/**
 * At more than this many social providers, `search: 'auto'` reveals the filter
 * box. Chosen so the common handful (Google/GitHub/…) stays button-only while a
 * genuinely long list gets a way to fit.
 */
export const SEARCH_AUTO_THRESHOLD = 8;

export interface SocialButtonsConfig {
  variant?: SocialButtonVariant;
  size?: SocialButtonSize;
  layout?: SocialButtonLayout;
  labels?: Record<string, string>;
  search?: SocialButtonSearch;
}

/**
 * The interaction / micro-polish layer — how controls *feel*, independent of the
 * colour tokens. Every knob has a flattering default so the widget looks polished
 * out of the box, and every one is a closed allow-list so a bad stored value can
 * only fall back, never render a broken attribute.
 *
 *   buttonStyle  — the primary CTA's fill: `solid` (default), `outline`, `soft`
 *     (tinted primary at low alpha), or `ghost` (text-only until hover). Social
 *     buttons keep their neutral provider styling regardless — recognisability.
 *   buttonEffect — press/hover feedback on every button: `scale` (subtle press-in,
 *     default), `lift` (raises on hover), `glow` (primary halo on hover), `ripple`
 *     (a material tap ripple), or `none`.
 *   shadow       — elevation of the card (and solid buttons): `none | sm | md | lg`.
 *   density      — spacing scale: `comfortable` (default) or `compact`.
 *   inputStyle   — field treatment: `outline` (default), `filled`, or `underline`.
 *   animations   — master motion switch (default on). `prefers-reduced-motion` is
 *     always honoured on top of this, never overridden by it.
 *   motionSpeed  — transition tempo: `slow | normal | fast`.
 */
export type ButtonStyle = 'solid' | 'outline' | 'soft' | 'ghost';
export type ButtonEffect = 'none' | 'scale' | 'lift' | 'glow' | 'ripple';
export type ShadowDepth = 'none' | 'sm' | 'md' | 'lg';
export type Density = 'comfortable' | 'compact';
export type InputStyle = 'outline' | 'filled' | 'underline';
export type MotionSpeed = 'slow' | 'normal' | 'fast';
/**
 * How the widget shows it is working — while it fetches the tenant's appearance,
 * exchanges an OAuth/hosted ticket on redirect-back, or a form is submitting.
 *   spinner  — a centred brand spinner (default).
 *   skeleton — shimmer placeholders shaped like the form (title + fields + button).
 *   dots     — three pulsing dots.
 *   bar      — an indeterminate progress bar across the top of the card.
 */
export type LoadingStyle = 'spinner' | 'skeleton' | 'dots' | 'bar';

export interface InteractionConfig {
  buttonStyle?: ButtonStyle;
  buttonEffect?: ButtonEffect;
  shadow?: ShadowDepth;
  density?: Density;
  inputStyle?: InputStyle;
  animations?: boolean;
  motionSpeed?: MotionSpeed;
  loading?: LoadingStyle;
}

export interface ResolvedInteraction {
  buttonStyle: ButtonStyle;
  buttonEffect: ButtonEffect;
  shadow: ShadowDepth;
  density: Density;
  inputStyle: InputStyle;
  animations: boolean;
  motionSpeed: MotionSpeed;
  loading: LoadingStyle;
}

const BUTTON_STYLES: readonly ButtonStyle[] = ['solid', 'outline', 'soft', 'ghost'];
const BUTTON_EFFECTS: readonly ButtonEffect[] = ['none', 'scale', 'lift', 'glow', 'ripple'];
const SHADOWS: readonly ShadowDepth[] = ['none', 'sm', 'md', 'lg'];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
const INPUT_STYLES: readonly InputStyle[] = ['outline', 'filled', 'underline'];
const MOTION_SPEEDS: readonly MotionSpeed[] = ['slow', 'normal', 'fast'];
const LOADING_STYLES: readonly LoadingStyle[] = ['spinner', 'skeleton', 'dots', 'bar'];

/** Transition duration (ms) per tempo — read by the widget into a CSS var. */
export const MOTION_MS: Record<MotionSpeed, number> = { slow: 280, normal: 160, fast: 80 };

/**
 * Resolve the interaction config: inline override wins over the tenant's
 * server-side default, each validated against its allow-list, else a flattering
 * default. `buttonEffect: 'scale'` and `animations: true` are the defaults so the
 * widget feels alive out of the box; a tenant can dial any of it back.
 */
export function resolveInteraction(
  server: InteractionConfig | undefined,
  inline: InteractionConfig | undefined,
): ResolvedInteraction {
  const pick = <T,>(allowed: readonly T[], fallback: T, ...vals: (T | undefined)[]): T => {
    for (const v of vals) if (v !== undefined && allowed.includes(v)) return v;
    return fallback;
  };
  return {
    buttonStyle: pick(BUTTON_STYLES, 'solid', inline?.buttonStyle, server?.buttonStyle),
    buttonEffect: pick(BUTTON_EFFECTS, 'scale', inline?.buttonEffect, server?.buttonEffect),
    shadow: pick(SHADOWS, 'md', inline?.shadow, server?.shadow),
    density: pick(DENSITIES, 'comfortable', inline?.density, server?.density),
    inputStyle: pick(INPUT_STYLES, 'outline', inline?.inputStyle, server?.inputStyle),
    animations:
      typeof inline?.animations === 'boolean'
        ? inline.animations
        : typeof server?.animations === 'boolean'
          ? server.animations
          : true,
    motionSpeed: pick(MOTION_SPEEDS, 'normal', inline?.motionSpeed, server?.motionSpeed),
    loading: pick(LOADING_STYLES, 'spinner', inline?.loading, server?.loading),
  };
}

export interface ResolvedSocialButtons {
  variant: SocialButtonVariant;
  size: SocialButtonSize;
  layout: SocialButtonLayout;
  labels: Record<string, string>;
  search: SocialButtonSearch;
}

const VARIANTS: readonly SocialButtonVariant[] = ['block', 'compact', 'icon'];
const SIZES: readonly SocialButtonSize[] = ['sm', 'md', 'lg'];
const LAYOUTS: readonly SocialButtonLayout[] = ['list', 'grid', 'carousel'];
const SEARCH_MODES: readonly SocialButtonSearch[] = ['auto', 'always', 'never'];

/**
 * Resolve the social-button config from the tenant's server-side default merged
 * with the inline override (which wins), falling back to safe defaults. Every
 * value is validated against its allow-list, so a bad stored value can never
 * produce a broken `data-variant` — it just falls back.
 */
export function resolveSocialButtons(
  server: SocialButtonsConfig | undefined,
  inline: SocialButtonsConfig | undefined,
): ResolvedSocialButtons {
  const pick = <T,>(allowed: readonly T[], ...vals: (T | undefined)[]): T => {
    for (const v of vals) if (v !== undefined && allowed.includes(v)) return v;
    return allowed[0]!;
  };
  return {
    variant: pick(VARIANTS, inline?.variant, server?.variant),
    size: pick(SIZES, inline?.size ?? 'md', server?.size, 'md'),
    layout: pick(LAYOUTS, inline?.layout, server?.layout),
    labels: { ...(server?.labels ?? {}), ...(inline?.labels ?? {}) },
    search: pick(SEARCH_MODES, inline?.search, server?.search),
  };
}

/** The inline override an embedding page may pass as `appearance`. */
export interface WidgetAppearance {
  variables?: DesignTokens;
  elements?: Partial<Record<ElementKey, string>>;
  /** How the social buttons look — variant, size, layout, per-provider labels. */
  socialButtons?: SocialButtonsConfig;
  /** How a verification code is entered — segmented `boxes` (default) or `single`. */
  codeInput?: CodeInputStyle;
  /** How controls feel — button style/effect, shadow, density, input style, motion. */
  interaction?: InteractionConfig;
}

/** First-party strategies the instance has switched on. */
export interface PublicStrategies {
  password: boolean;
  emailCode: boolean;
  emailLink: boolean;
  passkey: boolean;
  phoneCode: boolean;
  siwe: boolean;
}

/**
 * The tenant's public appearance, exactly the shape `GET /v1/appearance`
 * returns under `appearance`. Every value is already resolved and sanitised
 * server-side; NONE of it is a secret.
 */
export interface PublicAppearance {
  applicationName: string;
  logoUrl: string | null;
  colorPrimary: string;
  colorBackground: string;
  colorText: string;
  colorAccent: string;
  colorCard: string;
  colorBorder: string;
  borderRadius: string;
  theme: 'light' | 'dark' | 'auto';
  fontStack: string;
  layout: 'centered' | 'split' | 'wall';
  headline: string | null;
  subheadline: string | null;
  footer: string | null;
  providerOrder: string[];
  providerHidden: string[];
  /** Tenant's server-side default for the social buttons; the inline override wins. */
  socialButtons?: SocialButtonsConfig;
  /** Tenant's server-side default for the code-input style; the inline override wins. */
  codeInput?: CodeInputStyle;
  /** Tenant's server-side interaction/polish defaults; the inline override wins. */
  interaction?: InteractionConfig;
  /** §5.1 legal consent on sign-up — Terms/Privacy links + whether it is required. */
  legal?: { termsUrl: string | null; privacyUrl: string | null; required: boolean };
  /** §5 extra fields the create-account form collects (name, company, custom…). */
  signUpFields?: PublicSignUpField[];
}

/** One configurable sign-up field, exactly as `/v1/appearance` resolves it. */
export interface PublicSignUpField {
  key: string;
  label: string;
  type:
    | 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea'
    | 'checkbox' | 'select' | 'radio' | 'multiselect';
  required: boolean;
  placeholder: string | null;
  options: string[];
  builtin: boolean;
}

/** The full `GET /v1/appearance` envelope. */
export interface AppearanceResponse {
  object: 'appearance';
  appearance: PublicAppearance;
  /** ENABLED social provider ids (keys only), e.g. `['google','github']`. */
  providers: string[];
  /**
   * Enabled providers that support native / One-Tap sign-in, WITH their public
   * client_id — a subset of `providers`. The widget uses this to render the
   * official Google Identity Services button instead of the redirect flow. A
   * client_id is public; no secret is ever here.
   */
  native_providers?: { provider: string; client_id: string }[];
  /**
   * §6.5 per-provider sign-in / sign-up scope. A provider absent from this map
   * is unscoped (shows on both screens). The widget uses it with its `mode` to
   * render a provider only on the screen it belongs on — the server enforces
   * the same at the resolver, so the button and the outcome always agree.
   */
  provider_scopes?: Record<string, { sign_in: boolean; sign_up: boolean }>;
  strategies: PublicStrategies;
  /**
   * "Sign in with Atlas" — the preset OIDC connection's state. When enabled, the
   * widget renders a "Sign in with Atlas" button that starts the SSO flow for
   * `connection_id`. Off (no button) when absent or `{ enabled: false }`.
   */
  sign_in_with_atlas?: { enabled: boolean; connection_id?: string };
  /** §7.5 whether the widget shows a "Remember me" checkbox at sign-in. */
  rememberMe?: boolean;
  /** §5.3 whether the widget shows a "Remember this device" checkbox at 2FA. */
  rememberDevice?: boolean;
  /**
   * §5 per-flow captcha the widget renders. Public fields only (provider, site
   * key, render mode) — the secret stays server-side. A disabled flow reports
   * `{ enabled: false }`, so the widget draws nothing there.
   */
  captchaFlows?: Partial<Record<CaptchaFlowKey, FlowCaptcha>>;
}

export type CaptchaFlowKey = 'signUp' | 'signIn' | 'guest' | 'passwordReset';
export type CaptchaWidgetMode = 'invisible' | 'managed' | 'visible';
export interface FlowCaptcha {
  enabled: boolean;
  provider?: string;
  siteKey?: string | null;
  widget?: CaptchaWidgetMode;
}

/** The unstyled defaults, so the widget looks right before any fetch resolves. */
export const DEFAULT_TOKENS: Required<DesignTokens> = {
  colorPrimary: '#5b5bd6',
  colorText: '#1c1c1f',
  colorBackground: '#ffffff',
  colorAccent: '#5b5bd6',
  colorCard: '#ffffff',
  colorBorder: '#e4e4e9',
  borderRadius: '10px',
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

/** Tokens implied by a fetched public appearance. */
export function tokensFromAppearance(appearance: PublicAppearance | null): Required<DesignTokens> {
  if (!appearance) return DEFAULT_TOKENS;
  return {
    colorPrimary: appearance.colorPrimary || DEFAULT_TOKENS.colorPrimary,
    colorText: appearance.colorText || DEFAULT_TOKENS.colorText,
    colorBackground: appearance.colorBackground || DEFAULT_TOKENS.colorBackground,
    colorAccent: appearance.colorAccent || appearance.colorPrimary || DEFAULT_TOKENS.colorAccent,
    colorCard: appearance.colorCard || appearance.colorBackground || DEFAULT_TOKENS.colorCard,
    colorBorder: appearance.colorBorder || DEFAULT_TOKENS.colorBorder,
    borderRadius: appearance.borderRadius || DEFAULT_TOKENS.borderRadius,
    fontFamily: appearance.fontStack || DEFAULT_TOKENS.fontFamily,
  };
}

/**
 * Resolve final tokens: defaults, then the tenant's appearance, then the inline
 * override. Later wins and `undefined` never overwrites — a page setting one
 * variable keeps the other seven from the tenant.
 */
export function resolveTokens(
  appearance: PublicAppearance | null,
  override?: WidgetAppearance,
): Required<DesignTokens> {
  const resolved = { ...tokensFromAppearance(appearance) };
  const overrides = override?.variables ?? {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) resolved[key as keyof DesignTokens] = value;
  }
  return resolved;
}

/** Tokens as `--atlas-embed-*` custom properties for the root element. */
export function cssVariables(tokens: Required<DesignTokens>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    vars[`--atlas-embed-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
  }
  return vars;
}

/** Our base class plus the page's override, appended so theirs wins on ties. */
export function classFor(
  element: ElementKey,
  base: string,
  override?: WidgetAppearance,
): string {
  const extra = override?.elements?.[element];
  return extra ? `${base} ${extra}` : base;
}

/**
 * The provider ids to render, in order, with hidden ones removed.
 *
 * The server already returns only ENABLED providers; `providerOrder` is the
 * tenant's display preference and `providerHidden` a suppression list, both
 * cosmetic. Ordered providers come first (in the tenant's order), then any
 * remaining enabled providers in their original order.
 */
export function orderedProviders(
  enabled: readonly string[],
  appearance: PublicAppearance | null,
): string[] {
  const order = appearance?.providerOrder ?? [];
  const hidden = new Set(appearance?.providerHidden ?? []);
  const enabledSet = new Set(enabled.filter((id) => !hidden.has(id)));

  const out: string[] = [];
  for (const id of order) {
    if (enabledSet.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of enabled) {
    if (enabledSet.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A human label for a provider id, for the "Continue with …" buttons. */
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  gitlab: 'GitLab',
  facebook: 'Facebook',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  twitter: 'X',
  twitter_v1: 'X',
  x: 'X',
  slack: 'Slack',
  spotify: 'Spotify',
  twitch: 'Twitch',
  notion: 'Notion',
  linear: 'Linear',
  steam: 'Steam',
};

export function providerLabel(id: string): string {
  if (PROVIDER_LABELS[id]) return PROVIDER_LABELS[id]!;
  return id
    .split(/[_-]/)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}
