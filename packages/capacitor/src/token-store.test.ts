import { describe, expect, it } from 'vitest';
import type { PreferencesPlugin } from './plugins';
import {
  createInMemoryTokenStore,
  createPreferencesTokenStore,
  DEFAULT_SESSION_KEY,
} from './token-store';

/** A fake `@capacitor/preferences` Preferences, backed by a Map, for round-tripping. */
function fakePreferences(): PreferencesPlugin & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async ({ key }) => ({ value: map.get(key) ?? null }),
    set: async ({ key, value }) => {
      map.set(key, value);
    },
    remove: async ({ key }) => {
      map.delete(key);
    },
  };
}

describe('createPreferencesTokenStore', () => {
  it('round-trips a value through the Preferences stub under the given key', async () => {
    const prefs = fakePreferences();
    const store = createPreferencesTokenStore(prefs, 'atlas.custom');

    expect(await store.getToken()).toBeNull();
    await store.setToken('the-session-json');
    expect(prefs.map.get('atlas.custom')).toBe('the-session-json');
    expect(await store.getToken()).toBe('the-session-json');

    await store.clearToken();
    expect(await store.getToken()).toBeNull();
    expect(prefs.map.has('atlas.custom')).toBe(false);
  });

  it('defaults to the session key', async () => {
    const prefs = fakePreferences();
    const store = createPreferencesTokenStore(prefs);
    await store.setToken('x');
    expect(prefs.map.get(DEFAULT_SESSION_KEY)).toBe('x');
  });
});

describe('createInMemoryTokenStore', () => {
  it('round-trips in memory', async () => {
    const store = createInMemoryTokenStore();
    expect(await store.getToken()).toBeNull();
    await store.setToken('v');
    expect(await store.getToken()).toBe('v');
    await store.clearToken();
    expect(await store.getToken()).toBeNull();
  });
});
