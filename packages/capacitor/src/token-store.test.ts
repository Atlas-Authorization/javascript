import { describe, expect, it } from 'vitest';
import type { PreferencesPlugin } from './plugins';
import { SessionTombstones } from '@atlasauth/js';
import {
  createInMemoryTokenStore,
  createPreferencesTokenStore,
  createPreferencesTombstoneStore,
  DEFAULT_SESSION_KEY,
  tombstoneStoreFromTokenStore,
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

describe('tombstone stores', () => {
  it('keeps signed-out session ids in Preferences, across instances', async () => {
    const prefs = fakePreferences();
    const first = new SessionTombstones({ frontendApi: 'https://fapi.example.test', store: createPreferencesTombstoneStore(prefs) });
    await first.ready;
    first.add('sess_1');
    await new Promise((r) => setTimeout(r, 0));
    expect(prefs.map.get('atlas:signed-out-sessions:https://fapi.example.test')).toContain('sess_1');

    const restarted = new SessionTombstones({ frontendApi: 'https://fapi.example.test', store: createPreferencesTombstoneStore(prefs) });
    await restarted.ready;
    expect(restarted.has('sess_1')).toBe(true);
  });

  it('adapts a single-slot TokenStore (its own slot, whatever the key)', async () => {
    const slot = createInMemoryTokenStore();
    const store = tombstoneStoreFromTokenStore(slot);
    await store.setItem('any-key', '["x"]');
    expect(await slot.getToken()).toBe('["x"]');
    expect(await store.getItem('another-key')).toBe('["x"]');
  });
});
