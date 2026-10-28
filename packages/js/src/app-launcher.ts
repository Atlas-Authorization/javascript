import type { FapiClient } from './fapi';

/** One app the signed-in user may launch from the app launcher. */
export interface LauncherApp {
  id: string;
  name: string;
  presetId: string | null;
  /** Navigate here to start IdP-initiated single sign-on to the app. */
  launchUrl: string;
}

interface WireLauncherApp {
  id: string;
  name: string;
  preset_id: string | null;
  launch_url: string;
}

/** The apps the signed-in user may launch. Rejects when nobody is signed in. */
export async function listLauncherApps(client: FapiClient): Promise<LauncherApp[]> {
  const res = await client.request<{ data: WireLauncherApp[] }>('/v1/saml/idp/apps', { method: 'GET' });
  if (!res.ok || !res.data) {
    throw new Error(res.errors[0]?.message ?? 'Could not load your apps.');
  }
  return res.data.data.map((a) => ({ id: a.id, name: a.name, presetId: a.preset_id, launchUrl: a.launch_url }));
}

/**
 * Where to send the browser to sign out of Atlas and every SAML app it signed in to (single logout).
 * Navigate to it; apps that publish a logout endpoint are told, then a signed-out page is shown.
 */
export function samlLogoutUrl(client: FapiClient): string {
  return client.urlFor(`/v1/saml/idp/slo/start?pk=${encodeURIComponent(client.publishableKey)}`);
}
