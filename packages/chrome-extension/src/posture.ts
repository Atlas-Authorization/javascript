import type { FapiClient } from '@atlasauth/js';
import type { AtlasClient } from './client';

/** The slice of `navigator` read for posture, so it can be passed in and tested. */
export interface PostureNavigator {
  userAgent?: string;
  platform?: string;
  userAgentData?: {
    platform?: string;
    brands?: Array<{ brand: string; version: string }>;
    getHighEntropyValues?(hints: string[]): Promise<{ platformVersion?: string; uaFullVersion?: string }>;
  };
}

export interface BrowserPosture {
  platform: string;
  os_version?: string;
  browser?: string;
  browser_version?: string;
}

const BROWSER_BRANDS = ['Microsoft Edge', 'Google Chrome', 'Chromium', 'Brave', 'Opera'];

/**
 * What a browser can honestly say about itself: the OS family, its version (high-entropy client hints; for
 * Windows the Windows-11 style `platformVersion` is the NT build and is passed through as reported), and the
 * browser brand and version. No hardware, encryption or screen-lock facts: a browser cannot attest those,
 * so Atlas never accepts them from here.
 */
export async function collectBrowserPosture(nav: PostureNavigator = (globalThis as { navigator?: PostureNavigator }).navigator ?? {}): Promise<BrowserPosture> {
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || 'unknown';
  const out: BrowserPosture = { platform };
  const brand = nav.userAgentData?.brands?.find((b) => BROWSER_BRANDS.includes(b.brand));
  if (brand) {
    out.browser = brand.brand;
    out.browser_version = brand.version;
  }
  try {
    const high = await nav.userAgentData?.getHighEntropyValues?.(['platformVersion', 'uaFullVersion']);
    if (high?.platformVersion) out.os_version = high.platformVersion;
    if (high?.uaFullVersion) out.browser_version = high.uaFullVersion;
  } catch {
    // Client hints can be blocked; the report still carries the platform.
  }
  return out;
}

/** A stable per-install id kept in extension storage (generated on first use). */
export async function installId(storage: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }, random: () => string = () => crypto.randomUUID()): Promise<string> {
  const existing = await storage.get('atlas_install_id');
  if (existing) return existing;
  const fresh = random();
  await storage.set('atlas_install_id', fresh);
  return fresh;
}

/**
 * Report this browser's posture for the signed-in user (`POST /v1/client/me/device_posture`). Self-reported
 * and unmanaged: it feeds platform and OS-version conditions, never device trust.
 */
export async function reportDevicePosture(
  client: Pick<AtlasClient, 'fapi'> & { fapi: Pick<FapiClient, 'post'> },
  opts: { installId: string; navigator?: PostureNavigator },
): Promise<void> {
  const posture = await collectBrowserPosture(opts.navigator);
  const res = await client.fapi.post('/v1/client/me/device_posture', { install_id: opts.installId, ...posture });
  if (!res.ok) throw new Error(`Posture report failed (${res.status}).`);
}
