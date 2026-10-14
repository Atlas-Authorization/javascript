import {
  composeDesign,
  isDevelopment,
  type DesignWarn,
  type InstanceDesign,
  type LegacyDesignTokens,
} from './client';
import type { AtlasDesign, PresetId } from './schema';

/**
 * The framework-neutral half of an SDK's `appearance` handling, shared by the
 * React, Vue, Svelte, Angular and embed packages so they cannot drift.
 */

/** The design-system fields every SDK's `Appearance` accepts. */
export interface DesignAppearance {
  /** A design preset; replaces the dashboard design as the starting point. */
  preset?: PresetId;
  /** Structured design overrides; highest precedence. */
  design?: AtlasDesign;
  /** Apply the dashboard design automatically (default true). */
  instanceDesign?: boolean;
}

/** What an SDK puts on its root element and in the document. */
export interface AppearanceRender {
  /** Inline custom properties for the root. */
  style: Record<string, string>;
  /** `data-atlas-*` attributes for the root (empty without a design). */
  attributes: Record<string, string>;
  /** The design stylesheet ('' without a design). */
  css: string;
  /** Stable key of the stylesheet (the `data-atlas-design` value). */
  key: string;
  /** Self-hosted web-font stylesheets to link. */
  fontStylesheets: string[];
}

const warned = new Set<string>();
/** Development-only and de-duplicated, so a re-render never repeats a warning. */
export const warnOnce: DesignWarn = (message) => {
  if (!isDevelopment() || warned.has(message)) return;
  warned.add(message);
  (globalThis as { console?: { warn(...a: unknown[]): void } }).console?.warn(`[atlas] ${message}`);
};

/**
 * Turn the design fields of an `appearance` (+ the dashboard design from the
 * Frontend API) into root attributes and a stylesheet.
 *
 * Precedence, lowest first: dashboard design < `preset` < legacy `tokens` <
 * `design`. Without a dashboard design and without `preset`/`design`, the
 * output is exactly the pre-design-system one: `legacyStyle()` inline, no
 * stylesheet, no attributes.
 */
export function renderDesignAppearance(
  appearance: DesignAppearance | undefined,
  instanceDesign: InstanceDesign | null | undefined,
  options: {
    /** The legacy tokens the developer set explicitly (they map onto the design). */
    tokens?: LegacyDesignTokens;
    /** The pre-design-system inline variables, used when no design is in play. */
    legacyStyle: () => Record<string, string>;
    frontendApi?: string;
    warn?: DesignWarn;
  },
): AppearanceRender {
  const composed = composeDesign({
    instance: appearance?.instanceDesign === false ? null : instanceDesign,
    preset: appearance?.preset,
    design: appearance?.design,
    tokens: options.tokens,
    frontendApi: options.frontendApi,
    warn: options.warn ?? warnOnce,
  });
  if (!composed.active) {
    return { style: options.legacyStyle(), attributes: {}, css: '', key: '', fontStylesheets: [] };
  }
  return {
    style: composed.rawVariables,
    attributes: composed.dataAttributes,
    css: composed.css,
    key: composed.key,
    fontStylesheets: composed.fontStylesheets,
  };
}

/**
 * Read the dashboard design out of a `GET /v1/appearance` body. Tolerant of
 * where it sits (top level, or inside `appearance`) and of its absence.
 */
export function instanceDesignFrom(body: unknown): InstanceDesign | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { design?: unknown; appearance?: { design?: unknown } };
  const d = b.design ?? b.appearance?.design;
  return d && typeof d === 'object' && (d as { resolved?: unknown }).resolved ? (d as InstanceDesign) : null;
}

// ---- imperative DOM application (Vue plugin, Angular, the embed widget) -----------------

/* Structural DOM types: this package does not depend on the DOM lib. */
interface DomElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
}
interface DomNode {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}
interface DomDocument {
  head: { appendChild(node: unknown): unknown; querySelectorAll(selector: string): ArrayLike<DomNode> };
  createElement(tag: string): DomNode & { rel?: string; href?: string };
}

/** What {@link applyAppearanceToDom} set last time, so the next call can undo it. */
export interface AppliedAppearance {
  attributes: string[];
  style: string[];
}

/**
 * Apply an {@link AppearanceRender} imperatively: inline variables and
 * attributes on `root`, the stylesheet once per document (a
 * `<style data-atlas-design="<key>">`, shared by every root with that design),
 * and each font `<link>` once per document. Pass the previous return value to
 * remove what an earlier render set (e.g. when the dashboard design arrives).
 */
export function applyAppearanceToDom(
  doc: DomDocument,
  root: DomElement,
  render: AppearanceRender,
  previous?: AppliedAppearance,
): AppliedAppearance {
  for (const name of previous?.attributes ?? []) {
    if (!(name in render.attributes)) root.removeAttribute(name);
  }
  for (const name of previous?.style ?? []) {
    if (!(name in render.style)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(render.style)) root.style.setProperty(name, value);
  for (const [name, value] of Object.entries(render.attributes)) root.setAttribute(name, value);

  if (render.css) {
    const existing = Array.from(doc.head.querySelectorAll('style[data-atlas-design]'));
    if (!existing.some((el) => el.getAttribute('data-atlas-design') === render.key)) {
      const style = doc.createElement('style');
      style.setAttribute('data-atlas-design', render.key);
      style.textContent = render.css;
      doc.head.appendChild(style);
    }
  }
  if (render.fontStylesheets.length) {
    const linked = new Set(
      Array.from(doc.head.querySelectorAll('link[data-atlas-font]')).map((el) => el.getAttribute('href')),
    );
    for (const href of render.fontStylesheets) {
      if (linked.has(href)) continue;
      const link = doc.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', href);
      link.setAttribute('data-atlas-font', '');
      doc.head.appendChild(link);
    }
  }
  return { attributes: Object.keys(render.attributes), style: Object.keys(render.style) };
}
