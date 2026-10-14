import {
  designDataAttributes,
  designFontUrls,
  designKey,
  fontStack,
  resolveComposedDesign,
  warnOnce,
  type AppearanceRender,
  type InstanceDesign,
  type ResolvedDesign,
} from '@atlasauth/design/runtime';
import type {
  DesignTokens,
  InteractionConfig,
  SocialButtonsConfig,
  WidgetAppearance,
} from './appearance';

/**
 * The design system for the widget (`<atlas-sign-in>` / `<atlas-sign-up>` and
 * `mount()`), with the same semantics as `@atlasauth/react`:
 *
 *   tenant branding < dashboard design < appearance.preset < appearance.variables < appearance.design
 *
 * The widget keeps its own stylesheet (the `--atlas-embed-*` tokens and the
 * interaction data-attributes), so a resolved design is TRANSLATED into those:
 * palette → colour tokens, shape → radius, typography → font stack, buttons /
 * inputs / elevation / density → the interaction config, social layout → the
 * social-button config. The root additionally carries the design's
 * `data-atlas-*` attributes as stable hooks for the host page.
 *
 * Size: the widget ships as one script, so it uses the zod-free runtime entry
 * and never compiles the `--atlas-*` design stylesheet (its own stylesheet
 * reads the `--atlas-embed-*` tokens instead) — the CSS compiler stays out of
 * `embed.js`.
 */

export interface WidgetDesign {
  /** Root attributes + font links (no stylesheet, no inline `style`). */
  render: AppearanceRender;
  /** Colour/shape/font tokens for the widget stylesheet. */
  tokens: Required<DesignTokens>;
  /** Interaction defaults implied by the design (the inline override still wins). */
  interaction: InteractionConfig;
  /** Social-button defaults implied by the design (the inline override still wins). */
  socialButtons: SocialButtonsConfig;
  resolved: ResolvedDesign;
}

/**
 * The design the widget renders, or null when there is none (no dashboard
 * design, no inline `preset`/`design`) — the widget then themes exactly as
 * before from the tenant branding and inline tokens.
 */
export function widgetDesign(
  instance: InstanceDesign | null | undefined,
  inline: WidgetAppearance | undefined,
  opts: { frontendApi?: string; prefersDark?: boolean } = {},
): WidgetDesign | null {
  const r = resolveComposedDesign({
    instance: inline?.instanceDesign === false ? null : instance,
    preset: inline?.preset,
    design: inline?.design,
    warn: warnOnce,
  });
  if (!r) return null;
  const dark = r.colorScheme === 'dark' || (r.colorScheme === 'auto' && !!opts.prefersDark);
  const p = dark ? r.paletteDark : r.palette;

  const tokens: Required<DesignTokens> = {
    colorPrimary: p.primary,
    colorText: p.text,
    colorBackground: p.background,
    colorAccent: p.accent,
    colorCard: p.surface,
    colorBorder: p.border,
    // The widget derives its card radius from the control radius (+4px); cap a
    // pill control radius so the card stays a card.
    borderRadius: `${Math.min(r.shape.controlRadius, 24)}px`,
    fontFamily: fontStack(r.typography.font),
  };
  // Inline variables win over the design, exactly as they win over the tenant's.
  for (const [key, value] of Object.entries(inline?.variables ?? {})) {
    if (value !== undefined) tokens[key as keyof DesignTokens] = value;
  }

  const shadow = r.elevation.cardShadow === 'xl' ? 'lg' : r.elevation.cardShadow;
  const interaction: InteractionConfig = {
    buttonStyle: r.buttons.style === 'gradient' ? 'solid' : r.buttons.style,
    shadow: r.card.style === 'outline' || r.card.style === 'none' ? 'none' : shadow,
    density: r.spacing.density === 'compact' ? 'compact' : 'comfortable',
    inputStyle: r.inputs.style,
  };
  const socialButtons: SocialButtonsConfig =
    r.buttons.socialLayout === 'icons'
      ? { variant: 'icon', layout: 'grid' }
      : { layout: r.buttons.socialLayout === 'grid' ? 'grid' : 'list' };

  const key = designKey(JSON.stringify(r));
  return {
    render: {
      style: {},
      attributes: { ...designDataAttributes(r), 'data-atlas-design': key },
      css: '',
      key,
      fontStylesheets: designFontUrls(r, opts.frontendApi),
    },
    tokens,
    interaction,
    socialButtons,
    resolved: r,
  };
}
