import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPasskey, passkeysSupported } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useUser } from './hooks';
import { collectByType, useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';

interface DeviceSession {
  id: string;
  current: boolean;
  last_active_at: number;
  device_label?: string | null;
  browser?: string | null;
  os?: string | null;
  location?: string | null;
}

/**
 * §2 The signed-in user's active devices, with per-device and "sign out everyone
 * else" revocation. A drop-in for a settings page — the composable half of the
 * post-login account surface an integrator needs the moment login is Atlas.
 */
export function ActiveSessions() {
  const client = useMeClient();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await client.get<{ data?: DeviceSession[] }>('/v1/client/sessions');
    setSessions(res.data?.data ?? []);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      await client.post(`/v1/client/sessions/${id}/revoke`).catch(() => undefined);
      await load();
      setBusy(false);
    },
    [client, load],
  );
  const revokeOthers = useCallback(async () => {
    setBusy(true);
    await client.post('/v1/client/sessions/revoke_all').catch(() => undefined);
    await load();
    setBusy(false);
  }, [client, load]);

  const fmt = (ms: number) => new Date(ms).toLocaleString();

  return (
    <section className={cardClass} data-atlas="active-sessions">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Active devices</h2>
      <ul className={cls('list', 'atlas-list')}>
        {sessions.map((s) => (
          <li className={cls('listItem', 'atlas-list-item')} key={s.id}>
            <strong>{s.device_label ?? [s.browser, s.os].filter(Boolean).join(' on ') ?? 'Unknown device'}</strong>
            {s.current ? <em> — this device</em> : null}
            <div>{[s.location, fmt(s.last_active_at)].filter(Boolean).join(' · ')}</div>
            {!s.current ? (
              <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void revoke(s.id)}>
                Sign out
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {sessions.some((s) => !s.current) ? (
        <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void revokeOthers()}>
          Sign out of all other devices
        </button>
      ) : null}
    </section>
  );
}

/**
 * §2 The signed-in user's profile — name (editable) and email addresses. Another
 * composable piece of the account surface; writes go to `PATCH /v1/client/me` and
 * re-boot the provider so the rest of the app sees the change.
 */
export function ProfileCard() {
  const { user } = useUser();
  const { reload } = useAtlas();
  const client = useMeClient();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFirstName(user?.first_name ?? '');
    setLastName(user?.last_name ?? '');
  }, [user?.first_name, user?.last_name]);

  if (!user) return null;

  const save = async () => {
    setSaving(true);
    await client
      .request('/v1/client/me', {
        method: 'PATCH',
        body: JSON.stringify({ first_name: firstName, last_name: lastName }),
      })
      .catch(() => undefined);
    await reload();
    setSaving(false);
  };

  return (
    <section className={cardClass} data-atlas="profile-card">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Profile</h2>
      <label className={cls('formField', 'atlas-account-field')}>
        First name
        <input className={cls('formFieldInput', 'atlas-account-input')} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      </label>
      <label className={cls('formField', 'atlas-account-field')}>
        Last name
        <input className={cls('formFieldInput', 'atlas-account-input')} value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </label>
      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={saving} onClick={() => void save()}>
        Save
      </button>
      <ul className={cls('list', 'atlas-list')} data-atlas="emails">
        {(user.email_addresses ?? []).map((email) => (
          <li className={cls('listItem', 'atlas-list-item')} key={email.id}>
            {email.email_address}
            {email.verified ? null : <em> — unverified</em>}
            {email.primary ? <em> — primary</em> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface MfaFactor {
  id: string;
  type: string;
  verified: boolean;
}

/**
 * §2 Manage two-factor authentication (authenticator app / TOTP). The full
 * enrollment ceremony — start (secret + otpauth URI), verify with a live code,
 * then the one-time backup codes — plus turn-off, in one composable drop-in, so a
 * team never rebuilds the FAPI dance to put 2FA in their own settings page. The
 * secret + `otpauth://` URI are shown for scan-or-manual entry (render a QR from
 * the URI if you like — kept dependency-free here).
 */
export function ManageMfa() {
  const client = useMeClient();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; secret: string; uri: string; requiredCodes: number } | null>(
    null,
  );
  const [codes, setCodes] = useState<string[]>([]);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await client.get<{ data?: MfaFactor[]; backup_codes_remaining?: number }>(
      '/v1/client/me/mfa',
    );
    setFactors(res.data?.data ?? []);
    setRemaining(res.data?.backup_codes_remaining ?? null);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const totp = factors.find((f) => f.type === 'totp' && f.verified);

  const startEnroll = async () => {
    setError(null);
    setBackupCodes(null);
    setBusy(true);
    const res = await client.post<{ id: string; secret: string; uri: string; required_codes: number }>(
      '/v1/client/me/mfa/totp',
    );
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.errors[0] ? errorText(res.errors[0]) : 'Could not start enrollment.');
      return;
    }
    const required = res.data.required_codes || 1;
    setEnroll({ id: res.data.id, secret: res.data.secret, uri: res.data.uri, requiredCodes: required });
    setCodes(Array.from({ length: required }, () => ''));
  };

  const verify = async () => {
    if (!enroll) return;
    setError(null);
    setBusy(true);
    const res = await client.post<{ backup_codes?: string[] }>(
      `/v1/client/me/mfa/totp/${enroll.id}/verify`,
      { codes },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.errors[0] ? errorText(res.errors[0]) : 'That code was not accepted.');
      return;
    }
    setBackupCodes(res.data?.backup_codes ?? []);
    setEnroll(null);
    await load();
  };

  const disable = async (id: string) => {
    setBusy(true);
    await client.request(`/v1/client/me/mfa/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
    setBusy(false);
  };

  return (
    <section className={cardClass} data-atlas="manage-mfa">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Two-factor authentication</h2>
      {totp ? (
        <>
          <p className={cls('text', 'atlas-text')}>
            Authenticator app is on.
            {remaining != null ? ` ${remaining} backup codes remaining.` : ''}
          </p>
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void disable(totp.id)}>
            Turn off
          </button>
        </>
      ) : enroll ? (
        <div>
          <p className={cls('text', 'atlas-text')}>Add this to your authenticator app — scan the QR you render from the URI, or enter the key:</p>
          <code data-atlas="totp-secret">{enroll.secret}</code>
          <p className={cls('text', 'atlas-text')}>
            <a className={cls('link', 'atlas-link')} href={enroll.uri}>Open in an authenticator app</a>
          </p>
          {codes.map((c, i) => (
            <input className={cls('formFieldInput', 'atlas-account-input')}
              key={i}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={c}
              placeholder={enroll.requiredCodes > 1 ? `Code ${i + 1}` : 'Enter the 6-digit code'}
              onChange={(e) => setCodes((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          ))}
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void verify()}>
            Verify &amp; enable
          </button>
        </div>
      ) : backupCodes ? (
        <div>
          <p className={cls('text', 'atlas-text')}>Two-factor is on. Save these backup codes now — they are shown only once:</p>
          <ul className={cls('list', 'atlas-list')} data-atlas="backup-codes">
            {backupCodes.map((c) => (
              <li className={cls('listItem', 'atlas-list-item')} key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void startEnroll()}>
          Enable authenticator app
        </button>
      )}
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="mfa-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface Passkey {
  id: string;
  name?: string | null;
  last_used_at?: number | null;
  created_at: number;
}

/**
 * §2 Manage passkeys (WebAuthn). Lists the user's registered credentials and runs
 * the full add ceremony — `POST /passkeys/begin` → `navigator.credentials.create`
 * (via the SDK's {@link createPasskey}) → `POST /passkeys/finish` — plus rename-free
 * removal, in one composable drop-in. Nothing renders the "Add" affordance when the
 * runtime has no WebAuthn support, so it degrades cleanly on older browsers.
 */
export function ManagePasskeys() {
  const client = useMeClient();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = passkeysSupported();

  const load = useCallback(async () => {
    const res = await client.get<{ data?: Passkey[] }>('/v1/client/me/passkeys');
    setPasskeys(res.data?.data ?? []);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const begin = await client.post<Record<string, unknown>>('/v1/client/me/passkeys/begin');
      if (!begin.ok || !begin.data) {
        setError(begin.errors[0] ? errorText(begin.errors[0]) : 'Could not start passkey setup.');
        return;
      }
      const body = await createPasskey(begin.data, { name: name.trim() || undefined });
      const finish = await client.post('/v1/client/me/passkeys/finish', body);
      if (!finish.ok) {
        setError(finish.errors[0] ? errorText(finish.errors[0]) : 'Could not save the passkey.');
        return;
      }
      setName('');
      await load();
    } catch {
      // A cancelled or timed-out WebAuthn prompt throws — treat as a no-op, not an error banner.
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    await client.request(`/v1/client/me/passkeys/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
    setBusy(false);
  };

  const fmt = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString() : null);

  return (
    <section className={cardClass} data-atlas="manage-passkeys">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Passkeys</h2>
      <ul className={cls('list', 'atlas-list')} data-atlas="passkey-list">
        {passkeys.map((pk) => (
          <li className={cls('listItem', 'atlas-list-item')} key={pk.id}>
            <strong>{pk.name || 'Passkey'}</strong>
            <div>
              {[pk.last_used_at ? `Last used ${fmt(pk.last_used_at)}` : `Added ${fmt(pk.created_at)}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void remove(pk.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {supported ? (
        <div data-atlas="passkey-add">
          <input className={cls('formFieldInput', 'atlas-account-input')}
            value={name}
            placeholder="Name this device (optional)"
            onChange={(e) => setName(e.target.value)}
          />
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void add()}>
            Add a passkey
          </button>
        </div>
      ) : (
        <p className={cls('text', 'atlas-text')}>Passkeys are not supported in this browser.</p>
      )}
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="passkey-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * §2 The drop-in post-login account surface. Composes the account-management
 * pieces (profile, 2FA, passkeys, devices). Each piece is also exported on its own
 * (`<ProfileCard/>`, `<ManageMfa/>`, `<ManagePasskeys/>`, `<ActiveSessions/>`) so a
 * team can drop just one into their existing settings page.
 */
/**
 * §L3 extension API (Clerk `<UserProfile.Page>` / `<UserProfile.Link>`): add
 * your own tab of content, or an external link, into the prebuilt profile. Both
 * are descriptor components — `<UserProfile>` reads them from its children.
 */
export interface ProfilePageProps {
  /** The tab's label. */
  label: ReactNode;
  labelIcon?: ReactNode;
  /** The tab's body. */
  children?: ReactNode;
}
export interface ProfileLinkProps {
  label: ReactNode;
  labelIcon?: ReactNode;
  /** Where the tab navigates instead of showing content. */
  url: string;
}
/** A custom content tab inside `<UserProfile>`. Renders nothing on its own. */
function UserProfilePage(_props: ProfilePageProps): null {
  return null;
}
/** A custom external-link tab inside `<UserProfile>`. Renders nothing on its own. */
function UserProfileLink(_props: ProfileLinkProps): null {
  return null;
}

export function UserProfile({ children }: { children?: ReactNode } = {}) {
  const { user } = useUser();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const tabClass = cls('tab', useClass('menuItem', 'atlas-tab'));

  const pages = useMemo(
    () =>
      collectByType<ProfilePageProps>(children, (el) =>
        el.type === UserProfilePage ? (el.props as ProfilePageProps) : undefined,
      ),
    [children],
  );
  const links = useMemo(
    () =>
      collectByType<ProfileLinkProps>(children, (el) =>
        el.type === UserProfileLink ? (el.props as ProfileLinkProps) : undefined,
      ),
    [children],
  );

  // 0 = the built-in account page; 1..N = custom pages.
  const [tab, setTab] = useState(0);

  if (!user) return null;

  return (
    <div className={cardClass} data-atlas="user-profile">
      <h1 className={cls('headerTitle', 'atlas-heading')}>{t('userProfile.title')}</h1>

      {pages.length || links.length ? (
        <nav className={cls('tabs', 'atlas-tabs')} role="tablist">
          <button
            className={tabClass}
            role="tab"
            aria-selected={tab === 0}
            onClick={() => setTab(0)}
          >
            {t('userProfile.title')}
          </button>
          {pages.map((p, i) => (
            <button
              key={`p${i}`}
              className={tabClass}
              role="tab"
              aria-selected={tab === i + 1}
              onClick={() => setTab(i + 1)}
            >
              {p.labelIcon}
              {p.label}
            </button>
          ))}
          {links.map((l, i) => (
            <a key={`l${i}`} className={tabClass} href={l.url}>
              {l.labelIcon}
              {l.label}
            </a>
          ))}
        </nav>
      ) : null}

      {tab === 0 ? (
        <div data-atlas="user-profile-account" role="tabpanel">
          <ProfileCard />
          <ManageMfa />
          <ManagePasskeys />
          <ActiveSessions />
        </div>
      ) : (
        <div data-atlas="user-profile-custom" role="tabpanel">
          {pages[tab - 1]?.children}
        </div>
      )}
    </div>
  );
}
UserProfile.Page = UserProfilePage;
UserProfile.Link = UserProfileLink;
