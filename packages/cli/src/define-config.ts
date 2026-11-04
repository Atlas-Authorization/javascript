/**
 * The shape of an `atlas.config.ts`: one key per resource type, each holding
 * what `atlas config export` writes for that type (an object for a singleton
 * such as `instance`, a list for a collection such as `webhooks`). Run `atlas config export`
 * to start from your live instance. `${VAR}` placeholders are filled from the environment.
 */
export type AtlasConfig = Record<string, unknown>;

/** Identity helper for typing and editor completion: `export default defineConfig({ ... })`. */
export function defineConfig<T extends AtlasConfig | (() => AtlasConfig | Promise<AtlasConfig>)>(config: T): T {
  return config;
}
