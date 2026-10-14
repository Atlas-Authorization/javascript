/**
 * The Capacitor plugin surfaces this package touches — declared STRUCTURALLY so
 * the package carries no hard dependency on any `@capacitor/*` module.
 *
 * `@capacitor/core`, `@capacitor/browser`, `@capacitor/app` and
 * `@capacitor/preferences` are OPTIONAL peers the consuming app installs. So
 * instead of `import { Browser } from '@capacitor/browser'`, we declare the
 * minimal slice of each plugin we call and load the real module LAZILY at
 * runtime (see {@link loadCapacitorPlugins}). At build time there is no
 * dependency on any Capacitor package; at runtime the app's installed plugins
 * are structurally compatible, and a web target with a plugin absent degrades
 * gracefully rather than throwing at import.
 *
 * Every loader is guarded: a missing plugin resolves to `null`, never a throw,
 * so the package runs in a bare browser (no Capacitor runtime), in Node tests,
 * and on a device alike.
 */

/** The slice of `@capacitor/browser`'s `Browser` we use. */
export interface BrowserPlugin {
  /** Open `url` in the system browser (SFSafariViewController / Custom Tabs). */
  open(options: { url: string }): Promise<void>;
  /** Dismiss the in-app browser, when the platform supports it. */
  close?(): Promise<void>;
}

/** A Capacitor listener handle. `addListener` may return it directly or a promise of it. */
export interface PluginListenerHandle {
  remove(): Promise<void> | void;
}

/** The `appUrlOpen` event payload from `@capacitor/app`. */
export interface AppUrlOpenEvent {
  /** The full deep-link URL that reopened the app, e.g. `com.acme.app://cb?code=…`. */
  url: string;
}

/** The slice of `@capacitor/app`'s `App` we use. */
export interface AppPlugin {
  addListener(
    eventName: 'appUrlOpen',
    listener: (event: AppUrlOpenEvent) => void,
  ): PluginListenerHandle | Promise<PluginListenerHandle>;
}

/** The slice of `@capacitor/preferences`'s `Preferences` we use. */
export interface PreferencesPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/** The slice of `@capacitor/core`'s `Capacitor` we use. */
export interface CapacitorGlobal {
  /** True on iOS/Android, false on the web target. */
  isNativePlatform(): boolean;
}

/** The Capacitor plugins a flow needs; any may be absent (web, tests). */
export interface CapacitorPlugins {
  Browser: BrowserPlugin | null;
  App: AppPlugin | null;
  Preferences: PreferencesPlugin | null;
  Capacitor: CapacitorGlobal | null;
}

/**
 * Dynamically import a module by specifier WITHOUT a static dependency on it.
 *
 * The specifier is a runtime value, so TypeScript does not resolve the module at
 * build time (the package typechecks with no `@capacitor/*` installed) and a
 * bundler can tree-shake/ignore it. A missing or broken module resolves to
 * `null` rather than throwing — the caller decides how to degrade.
 */
async function loadModule<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as T;
  } catch {
    return null;
  }
}

/**
 * Lazily load the four Capacitor plugins, each guarded. A plugin that is not
 * installed (or whose import fails) comes back `null`; nothing throws. Capacitor
 * plugins export a named binding (`{ Browser }`, `{ App }`, …), so we read that
 * off the module.
 */
export async function loadCapacitorPlugins(): Promise<CapacitorPlugins> {
  const [browserMod, appMod, prefsMod, coreMod] = await Promise.all([
    loadModule<{ Browser?: BrowserPlugin }>('@capacitor/browser'),
    loadModule<{ App?: AppPlugin }>('@capacitor/app'),
    loadModule<{ Preferences?: PreferencesPlugin }>('@capacitor/preferences'),
    loadModule<{ Capacitor?: CapacitorGlobal }>('@capacitor/core'),
  ]);
  return {
    Browser: browserMod?.Browser ?? null,
    App: appMod?.App ?? null,
    Preferences: prefsMod?.Preferences ?? null,
    Capacitor: coreMod?.Capacitor ?? null,
  };
}

/**
 * Decide whether this is a native target. Prefers Capacitor's own
 * `isNativePlatform()`; falls back to "no `window` ⇒ not a browser ⇒ native-ish"
 * only when Capacitor is absent. On a plain web page (window present, no
 * Capacitor) it returns false, so the standard redirect flow is used.
 */
export function isNativePlatform(plugins: Pick<CapacitorPlugins, 'Capacitor'>): boolean {
  if (plugins.Capacitor) return plugins.Capacitor.isNativePlatform();
  return typeof window === 'undefined';
}
