import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { printJson } from '../output';
import { httpFor } from '../project';
import { instanceCredential } from './project-commands';
import { wantsJson } from './shared';

interface NativeApp {
  id: string;
  platform: 'ios' | 'android' | 'development';
  allowed_users?: string[];
  expires_at?: number;
  expired?: boolean;
  bundle_id?: string;
  team_id?: string;
  package_name?: string;
  callback_urls?: string[];
}
interface Provider {
  provider: string;
  display_name?: string;
  enabled?: boolean;
  has_secret?: boolean;
  redirect_uri?: string;
  hosted_id_token?: { available: boolean; redirect_uri: string } | null;
}
interface Finding {
  severity: string;
  code: string;
  message: string;
  fix: string;
}

type Unregistered = 'refuse' | 'device_bound' | 'allow';
interface NativeAppsConfig {
  unregistered?: Unregistered;
  unregisteredSession?: { absoluteMs?: number; requireMfa?: boolean };
}
const DOCS = 'https://atlasauth.net/docs/guides/native-device-bound-sessions';

const NATIVE_CODES = new Set(['native_dev_scheme_on_production', 'native_app_no_callback', 'native_platform_missing_callback', 'apple_sign_in_required', 'native_link_files_unreachable']);

/**
 * `atlas dev native [--provider discord]`: everything a native app needs from this instance in one place: the
 * publishable key and Frontend API URL to put in the app, the registered native apps with their callbacks, what
 * is still missing, and the exact sign-in call.
 */
export async function devNative(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const provider = str(args.values, 'provider') ?? 'discord';
  const api = httpFor(ctx, instanceCredential(ctx, args));
  const inst = await api.get<{ environment?: string; publishable_key?: string; frontend_api_host?: string | null; auth_config_resolved?: { nativeApps?: NativeAppsConfig }; auth_config?: { nativeApps?: NativeAppsConfig } }>('/v1/instance');
  const nativeCfg = inst.auth_config_resolved?.nativeApps ?? inst.auth_config?.nativeApps ?? {};
  const apps = ((await api.get<{ data?: NativeApp[] }>('/v1/native_apps').catch(() => ({ data: [] as NativeApp[] }))).data ?? []) as NativeApp[];
  const preflight = await api.get<{ findings?: Finding[] }>('/v1/instance/preflight').catch(() => ({ findings: [] as Finding[] }));
  const findings = (preflight.findings ?? []).filter((f) => NATIVE_CODES.has(f.code));
  const providers = (((await api.get<{ data?: Provider[] }>('/v1/oauth_providers?configured=true').catch(() => ({ data: [] as Provider[] }))).data ?? []) as Provider[]).filter((p) => p.enabled);
  // How each enabled provider signs in from an app, and the one URL its console needs.
  const providerLines = providers.map((p) =>
    p.has_secret
      ? { provider: p.provider, how: 'browser sign-in with the client secret', register: p.redirect_uri ?? null }
      : p.hosted_id_token?.available
        ? { provider: p.provider, how: 'browser sign-in with the client ID only (no secret needed)', register: p.hosted_id_token.redirect_uri }
        : { provider: p.provider, how: 'in-page or native SDK sign-in only: add a client secret for app browser sign-in', register: null },
  );
  const fapi = inst.frontend_api_host ? `https://${inst.frontend_api_host}` : null;
  const development = inst.environment === 'development';
  // Unset means device_bound on development and refuse on production.
  const policy: Unregistered = nativeCfg.unregistered ?? (development ? 'device_bound' : 'refuse');
  const now = Date.now();
  const devApps = apps.filter((a) => a.platform === 'development').map((a) => ({ ...a, expired: a.expired ?? (a.expires_at !== undefined && a.expires_at <= now) }));
  const registered = apps.filter((a) => a.platform !== 'development');

  const missing: string[] = [];
  if (policy === 'refuse' && !development && registered.length === 0 && devApps.every((a) => a.expired)) {
    missing.push(
      `Native clients with no registered app are refused on this instance, so Expo Go and unregistered builds cannot stay signed in. Register the app, or for a temporary build run POST /v1/native_apps {"platform":"development","allowed_users":["you@example.com"],"expires_at":<epoch ms, at most 90 days ahead>}, or set auth_config nativeApps.unregistered to "device_bound". See ${DOCS}`,
    );
  }
  for (const a of devApps) if (a.expired) missing.push(`Development app ${a.id} expired. Extend it with PATCH /v1/native_apps/${a.id} {"expires_at":<epoch ms, at most 90 days ahead>}.`);
  if (registered.length === 0 && devApps.length === 0) missing.push('No native app is registered. Add one under native_apps: in atlas.yaml (or POST /v1/native_apps) with its callback_urls.');
  for (const f of findings) missing.push(`${f.code}: ${f.message} ${f.fix}`.trim());

  if (wantsJson(args.values)) {
    printJson(ctx.io, { publishable_key: inst.publishable_key ?? null, frontend_api_url: fapi, environment: inst.environment ?? null, native_apps: apps, unregistered_policy: policy, unregistered_session: nativeCfg.unregisteredSession ?? null, providers: providerLines, missing });
    return 0;
  }
  ctx.io.out(`Publishable key:   ${inst.publishable_key ?? '(none)'}`);
  ctx.io.out(`Frontend API URL:  ${fapi ?? '(this instance has no Frontend API host yet)'}`);
  ctx.io.out(`Environment:       ${inst.environment ?? 'unknown'}`);
  ctx.io.out('');
  ctx.io.out(`Unregistered apps: ${policy}${nativeCfg.unregistered ? '' : ' (default)'}`);
  const us = nativeCfg.unregisteredSession;
  if (us?.absoluteMs) ctx.io.out(`  session capped at ${us.absoluteMs} ms`);
  if (us?.requireMfa) ctx.io.out('  MFA required before a refresh token is issued');
  ctx.io.out('');
  ctx.io.out('Native apps:');
  if (registered.length === 0) ctx.io.out('  (none)');
  for (const a of registered) {
    const who = a.platform === 'ios' ? `${a.team_id ?? '?'}.${a.bundle_id ?? '?'}` : (a.package_name ?? '?');
    ctx.io.out(`  ${a.id}  ${a.platform}  ${who}`);
    for (const u of a.callback_urls ?? []) ctx.io.out(`    callback  ${u}`);
    if (!a.callback_urls?.length) ctx.io.out('    (no callback URLs)');
  }
  if (devApps.length) {
    ctx.io.out('');
    ctx.io.out('Development apps:');
    for (const a of devApps) {
      ctx.io.out(`  ${a.id}  ${a.expired ? 'EXPIRED' : 'active'}  expires ${a.expires_at ? new Date(a.expires_at).toISOString() : '?'}`);
      ctx.io.out(`    users  ${(a.allowed_users ?? []).join(', ') || '(none)'}`);
      for (const u of a.callback_urls ?? []) ctx.io.out(`    callback  ${u}`);
    }
  }
  ctx.io.out('');
  ctx.io.out('Sign-in providers:');
  if (providerLines.length === 0) ctx.io.out('  (none enabled)');
  for (const p of providerLines) {
    ctx.io.out(`  ${p.provider}  ${p.how}`);
    if (p.register) ctx.io.out(`    register this redirect URI with the provider  ${p.register}`);
  }
  ctx.io.out('');
  if (missing.length) {
    ctx.io.out('Missing:');
    for (const m of missing) ctx.io.out(`  - ${m}`);
    ctx.io.out('');
  }
  const appId = registered[0]?.id;
  ctx.io.out('In your app (Expo):');
  ctx.io.out(`  <AtlasProvider publishableKey="${inst.publishable_key ?? 'pk_...'}"${appId ? ` appId="${appId}"` : ''}>`);
  ctx.io.out(`  const { signInWithOAuth } = useSignIn();`);
  ctx.io.out(`  const result = await signInWithOAuth('${provider}');`);
  if (development) {
    ctx.io.out('');
    ctx.io.out('Expo Go: on a development instance the SDK uses the exp:// URL Expo Go gives it (Linking.createURL), so no registration is needed there.');
    ctx.io.out('A development build or a store build uses the callback URLs registered above.');
  }
  return 0;
}
