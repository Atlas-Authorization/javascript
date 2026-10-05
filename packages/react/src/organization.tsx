import { useCallback, useState } from 'react';
import { useAtlas } from './AtlasProvider';
import { useOrganization } from './hooks';
import { useClass, useMeClient, useText } from './components-shared';
import { Protect } from './control-components';

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

/**
 * Clerk-parity `useOrganizationList()`. The memberships the signed-in user
 * belongs to, plus a `createOrganization(name)` that creates one through FAPI and
 * re-boots the provider so the new membership appears everywhere. `memberships`
 * comes straight from {@link useOrganization} (the same list `<OrganizationSwitcher>`
 * renders), so there is one source of truth for what the user belongs to.
 */
export function useOrganizationList(): {
  memberships: ReturnType<typeof useOrganization>['memberships'];
  createOrganization(name: string): Promise<{ id: string; name: string } | null>;
} {
  const { memberships } = useOrganization();
  const { reload } = useAtlas();
  const client = useMeClient();

  const createOrganization = useCallback(
    async (name: string) => {
      const res = await client.post<{ id: string; name: string }>('/v1/client/organizations', {
        name,
      });
      // Re-boot so the new membership lands in `memberships` for the whole app,
      // not just this hook's caller.
      await reload();
      return res.data;
    },
    [client, reload],
  );

  return { memberships, createOrganization };
}

/**
 * Clerk-parity `<CreateOrganization>`. A small name-and-submit form that creates
 * an organization via {@link useOrganizationList} and immediately makes it the
 * active org, so the user drops straight into the org they just made. Styled like
 * the `<SignUp>` card. `onCreate` fires with the created org for a caller that
 * wants to route afterwards.
 */
export function CreateOrganization({
  onCreate,
}: {
  onCreate?(organization: { id: string; name: string }): void;
} = {}) {
  const { createOrganization } = useOrganizationList();
  const { setActive } = useOrganization();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const org = await createOrganization(trimmed);
      if (!org) {
        setError(t('error.generic'));
        return;
      }
      await setActive(org.id);
      setName('');
      onCreate?.(org);
    } catch {
      setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={cardClass}
      data-atlas="create-organization"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className={titleClass}>{t('organization.createTitle')}</h2>
      <label className="atlas-field">
        <span>{t('organization.nameLabel')}</span>
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {error ? (
        <p className={errorClass} role="alert">
          {error}
        </p>
      ) : null}
      <button className={buttonClass} type="submit" disabled={busy || !name.trim()}>
        {t('organization.create')}
      </button>
    </form>
  );
}

/**
 * Clerk-parity `<OrganizationList>`. Every organization the user belongs to as a
 * button that switches to it (mirroring `<OrganizationSwitcher>`'s markup), plus
 * an inline `<CreateOrganization>` so a user with no orgs — or who wants another —
 * can make one without leaving the list.
 */
export function OrganizationList() {
  const { memberships, organization, setActive } = useOrganization();
  const t = useText();
  const menuClass = useClass('menu', 'atlas-menu');
  const itemClass = useClass('menuItem', 'atlas-menu-item');

  return (
    <div className={menuClass} data-atlas="organization-list">
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
      <span className={itemClass} data-atlas="organization-list-divider">
        {t('organization.orCreate')}
      </span>
      <CreateOrganization />
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
