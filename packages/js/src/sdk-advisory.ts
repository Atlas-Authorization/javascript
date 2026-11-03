import { ATLAS_JS_VERSION } from './version';

/**
 * SDK version advisories.
 *
 * Every Atlas browser SDK names itself on its Frontend API requests
 * (`X-Atlas-SDK: @atlasauth/react/0.10.0`). When that version has a known bug
 * fixed in a later release, the response carries
 * `Atlas-SDK-Advisory: upgrade; min=0.8.1; reason=email_code_sign_in` (several
 * comma-separated), and the SDK logs ONE console warning per advisory per page
 * load, so a pinned 0.x version (the caret trap: `^0.8.0` never moves past a
 * lockfile's 0.8.0) is noticed by whoever opens the console.
 */

/** Which SDK a request comes from. */
export interface AtlasSdkInfo {
  /** The npm package, e.g. `@atlasauth/react`. */
  name: string;
  version: string;
}

export const ATLAS_JS_SDK: AtlasSdkInfo = { name: '@atlasauth/js', version: ATLAS_JS_VERSION };

/** The request header naming the SDK. */
export const SDK_HEADER = 'x-atlas-sdk';
/** The response header carrying advisories (exposed to cross-origin SDKs by the Frontend API). */
export const SDK_ADVISORY_HEADER = 'atlas-sdk-advisory';

/** `@atlasauth/react/0.10.0`. */
export function sdkHeaderValue(sdk: AtlasSdkInfo): string {
  return `${sdk.name}/${sdk.version}`;
}

export interface SdkAdvisoryNotice {
  action: string;
  /** The first version that fixes it. */
  min: string | null;
  reason: string | null;
}

/** Parse an `Atlas-SDK-Advisory` value; unknown parameters are ignored, garbage yields []. */
export function parseSdkAdvisory(value: string | null | undefined): SdkAdvisoryNotice[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((part) => {
      const [action, ...params] = part.split(';').map((p) => p.trim());
      const get = (k: string) => params.find((p) => p.startsWith(`${k}=`))?.slice(k.length + 1) ?? null;
      return { action: action ?? '', min: get('min'), reason: get('reason') };
    })
    .filter((n) => n.action !== '');
}

/** Advisories already logged on this page load (module lifetime). */
const logged = new Set<string>();

/** Test hook: forget what has been logged, as a new page load would. */
export function resetSdkAdvisoryLog(): void {
  logged.clear();
}

/**
 * Read a response's advisory header and warn once per page load per advisory.
 * Never throws; a response without the header (or a server that does not send
 * it) does nothing. Returns the advisories newly logged.
 */
export function reportSdkAdvisory(
  response: { headers?: { get(name: string): string | null } } | null | undefined,
  sdk: AtlasSdkInfo,
  warn: (message: string) => void = defaultWarn,
): SdkAdvisoryNotice[] {
  let raw: string | null = null;
  try {
    raw = response?.headers?.get?.(SDK_ADVISORY_HEADER) ?? null;
  } catch {
    return [];
  }
  const fresh: SdkAdvisoryNotice[] = [];
  for (const notice of parseSdkAdvisory(raw)) {
    const key = `${sdk.name}|${notice.reason ?? ''}|${notice.min ?? ''}`;
    if (logged.has(key)) continue;
    logged.add(key);
    fresh.push(notice);
    warn(
      `[Atlas] ${sdk.name} ${sdk.version} has a known problem` +
        `${notice.reason ? ` (${notice.reason})` : ''}` +
        `${notice.min ? ` fixed in ${notice.min}. Upgrade ${sdk.name} to ${notice.min} or later` : '. Upgrade it'}` +
        ` — with a 0.x version a caret range does not move past your lockfile on its own. ` +
        `Details: https://atlasauth.net/v1/sdk_advisories/${encodeURIComponent(sdk.name)}`,
    );
  }
  return fresh;
}

function defaultWarn(message: string): void {
  if (typeof console !== 'undefined') console.warn(message);
}
