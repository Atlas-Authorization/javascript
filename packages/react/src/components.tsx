import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { nextStep, type AttemptView, type FieldError } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import {
  FapiClient,
  advance,
  flowFromPending,
  pollAttempt,
  shouldKeepPolling,
  type FlowState,
} from './fapi';
import { useAuth, useOrganization, useUser } from './hooks';
import { classFor } from './appearance';
import { translate } from './i18n';
import { evaluate, type ProtectCondition } from './protect';

/**
 * §10.2 components.
 *
 * `<SignIn/>` and `<SignUp/>` are "full multi-step flows driven entirely by the
 * server-side attempt status". That phrase is the design: this file contains no
 * decision about what comes next. It renders whatever `status` the server
 * returned, via the exhaustive mapping in @atlasauth/js — so adding a step to the
 * flow is a server change, and a client that has not shipped yet degrades to a
 * visible "needs an update" rather than a blank screen.
 */

function useClass(appearanceKey: Parameters<typeof classFor>[0], base: string) {
  const { appearance } = useAtlas();
  return classFor(appearanceKey, appearance, base);
}

function useText() {
  const { catalog } = useAtlas();
  return (key: string, vars?: Record<string, string>) => translate(catalog, key, vars);
}

export function SignedIn({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  // Renders nothing while loading rather than flashing the signed-out branch.
  if (!isLoaded || !isSignedIn) return null;
  return <>{children}</>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded || isSignedIn) return null;
  return <>{children}</>;
}

/** §10.2: render children only while the SDK is still loading. */
export function AtlasLoading({ children }: { children: ReactNode }) {
  const { isLoaded } = useUser();
  return isLoaded ? null : <>{children}</>;
}

/** §10.2: render children only once the SDK has finished loading — the
 * symmetric partner of {@link AtlasLoading}, so a consumer can show a spinner
 * and its resolved content without hand-rolling the inverse condition. */
export function AtlasLoaded({ children }: { children: ReactNode }) {
  const { isLoaded } = useUser();
  return isLoaded ? <>{children}</> : null;
}

/**
 * §10.2 `<Protect permission="…">`.
 *
 * A rendering helper, never an authorization boundary — anyone can flip the
 * condition in devtools. The server checking the same permission is what
 * actually stops them, and this component's job is only to avoid showing a
 * button that would fail.
 */
export function Protect({
  children,
  fallback = null,
  ...condition
}: ProtectCondition & { children: ReactNode; fallback?: ReactNode }) {
  const { claims, status } = useAtlas();
  if (status === 'loading') return null;
  return evaluate(claims, condition).allowed ? <>{children}</> : <>{fallback}</>;
}

export interface FlowProps {
  /** Where to send the user once the flow completes. */
  afterUrl?: string;
}

/**
 * The server-driven flow shell.
 *
 * Every branch comes from `nextStep`, which is exhaustive — including the
 * `unknown` case, which renders an honest message instead of nothing.
 */
function AttemptFlow({
  attempt,
  onSubmit,
  busy,
  errors,
  titleKey,
}: {
  attempt: AttemptView | null;
  onSubmit(values: Record<string, string>): void;
  busy: boolean;
  errors: FieldError[];
  titleKey: string;
}) {
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');

  const [values, setValues] = useState<Record<string, string>>({});
  const step = attempt ? nextStep(attempt) : { kind: 'collect_identifier' as const };

  const field = (name: string, labelKey: string, type = 'text') => (
    <label key={name} className="atlas-field">
      <span>{t(labelKey)}</span>
      <input
        className={inputClass}
        type={type}
        value={values[name] ?? ''}
        onChange={(event) => setValues((v) => ({ ...v, [name]: event.target.value }))}
      />
      {errors
        .filter((error) => error.param === name)
        .map((error) => (
          <span key={error.code} className={errorClass}>
            {error.message}
          </span>
        ))}
    </label>
  );

  const fields = () => {
    switch (step.kind) {
      case 'collect_identifier':
        return [field('identifier', 'signIn.identifierLabel', 'email')];
      case 'collect_first_factor':
        return [field('password', 'signIn.passwordLabel', 'password')];
      case 'collect_second_factor':
        return [field('code', 'mfa.codeLabel')];
      case 'enroll_second_factor':
        /**
         * Two codes, not one. §5.6 wants consecutive codes so a phone with a
         * fast clock fails here rather than on every sign-in afterwards, and
         * asking for one would hide that failure until it was expensive.
         */
        return [
          field('code', 'mfa.enrollFirstCodeLabel'),
          field('secondCode', 'mfa.enrollSecondCodeLabel'),
        ];
      case 'collect_email_code':
        return [field('code', 'signIn.emailCodeLabel')];
      case 'collect_new_password':
        return [field('password', 'reset.newPasswordLabel', 'password')];
      case 'await_oauth':
        return [<p key="oauth">{t('signIn.magicLinkSent')}</p>];
      case 'done':
        return [<p key="done">{t('signIn.checkOtherTab')}</p>];
      case 'restart':
        return [<p key="restart">{t('error.generic')}</p>];
      default:
        /**
         * A status this SDK version does not know. Saying so beats rendering
         * nothing, which is a blank login box the user cannot act on.
         */
        return [
          <p key="unknown" className={errorClass}>
            {t('error.generic')}
          </p>,
        ];
    }
  };

  return (
    <div className={cardClass}>
      <h1 className={titleClass}>{t(titleKey)}</h1>

      {errors
        .filter((error) => !error.param)
        .map((error) => (
          <p key={error.code} className={errorClass} role="alert">
            {error.message}
          </p>
        ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(values);
        }}
      >
        {fields()}
        {step.kind !== 'done' && step.kind !== 'await_oauth' ? (
          <button className={buttonClass} disabled={busy} type="submit">
            {t('signIn.submit')}
          </button>
        ) : null}
      </form>
    </div>
  );
}

/**
 * Drives the flow through `advance`, which owns the step-to-endpoint mapping.
 * This component never decides what comes next — it renders the status the
 * server returned and posts whatever the driver says the current step needs.
 */
function useFlow() {
  const { publishableKey, frontendApi, reload, pendingAttempt } = useAtlas();
  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const [state, setState] = useState<FlowState>(() => flowFromPending(pendingAttempt));

  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi }),
    [frontendApi, publishableKey],
  );

  const submit = useCallback(
    (values: Record<string, string>) => {
      void (async () => {
        setState((current) => ({ ...current, busy: true, errors: [] }));
        const next = await advance(client, state, values);
        setState(next);

        // On completion the response carries a one-time ticket (§7.1). Exchange
        // it for cookies over a same-origin request — FAPI is cross-origin to
        // the app and cannot set the cookie on the completion response itself —
        // THEN re-boot so the rest of the app sees a signed-in user.
        if (next.attempt?.status === 'complete') {
          if (next.ticket) {
            await client.post('/v1/client/tickets/exchange', {
              attempt_id: (next.attempt as { id?: string }).id,
              ticket: next.ticket,
            });
          }
          await reload();
        }
      })();
    },
    [client, reload, state],
  );

  /** §5.3: collect a sign-in completed by a link opened on another device. */
  useEffect(() => {
    if (!shouldKeepPolling(state)) return;

    const timer = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(client, state);
        setState(next);
        if (!ticket || !next.attempt) return;

        // The ticket is exchanged by a normal request, so no session token has
        // ever appeared in a URL.
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await reload();
      })();
    }, 2_000);

    return () => clearInterval(timer);
  }, [client, reload, state]);

  return { state, submit };
}

export function SignIn(_props: FlowProps = {}) {
  const { state, submit } = useFlow();

  return (
    <AttemptFlow
      attempt={state.attempt}
      busy={state.busy}
      errors={state.errors}
      titleKey="signIn.title"
      onSubmit={submit}
    />
  );
}

export function SignUp(_props: FlowProps = {}) {
  const { state, submit } = useFlow();

  return (
    <AttemptFlow
      attempt={state.attempt}
      busy={state.busy}
      errors={state.errors}
      titleKey="signUp.title"
      onSubmit={submit}
    />
  );
}

export function UserButton() {
  const { user } = useUser();
  const { signOut } = useAuth();
  const t = useText();
  const [open, setOpen] = useState(false);

  const avatarClass = useClass('avatar', 'atlas-avatar');
  const menuClass = useClass('menu', 'atlas-menu');
  const itemClass = useClass('menuItem', 'atlas-menu-item');

  if (!user) return null;

  const label = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '';

  return (
    <div className="atlas-user-button">
      <button className={avatarClass} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {user.image_url ? <img alt="" src={user.image_url} /> : <span>{label.slice(0, 1)}</span>}
      </button>

      {open ? (
        <div className={menuClass} role="menu">
          <span className={itemClass}>{label}</span>
          <button className={itemClass} onClick={() => void signOut()}>
            {t('userButton.signOut')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function OrganizationSwitcher() {
  const { memberships, organization, setActive } = useOrganization();
  const t = useText();
  const menuClass = useClass('menu', 'atlas-menu');
  const itemClass = useClass('menuItem', 'atlas-menu-item');

  return (
    <div className={menuClass}>
      <button className={itemClass} onClick={() => void setActive(null)}>
        {t('organization.personal')}
      </button>
      {memberships.map((membership) => (
        <button
          key={membership.organization.id}
          className={itemClass}
          disabled={membership.organization.id === organization?.id}
          onClick={() => void setActive(membership.organization.id)}
        >
          {membership.organization.name}
        </button>
      ))}
    </div>
  );
}

export function UserProfile() {
  const { user } = useUser();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');

  if (!user) return null;

  return (
    <div className={cardClass}>
      <h1>{t('userProfile.title')}</h1>

      <section>
        <h2>{t('userProfile.emailsSection')}</h2>
        <ul>
          {(user.email_addresses ?? []).map((email) => (
            <li key={email.id}>
              {email.email_address}
              {email.verified ? null : <em> — {t('userProfile.unverified')}</em>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>{t('userProfile.securitySection')}</h2>
        <p>{user.mfa_enabled ? '2FA on' : '2FA off'}</p>
      </section>
    </div>
  );
}

export function OrganizationProfile() {
  const { organization, membership } = useOrganization();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');

  if (!organization) return null;

  return (
    <div className={cardClass}>
      <h1>{organization.name}</h1>
      <p>
        {t('organization.roleLabel')}: {membership?.role}
      </p>
      {/* Management controls are gated on the ACTIVE org role, matching the
          server's §9.2 rule rather than duplicating a looser one. */}
      <Protect permission="org:sys_memberships:manage">
        <button>{t('organization.invite')}</button>
      </Protect>
    </div>
  );
}
