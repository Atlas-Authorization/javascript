'use client';

import { useState } from 'react';
import { actorFromClaims, type EndImpersonationResult, type ImpersonationActor } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useClasses, useText } from './components-shared';

/** What {@link useImpersonation} returns. */
export interface UseImpersonationReturn {
  /** The active session is an impersonation (its token carries `act`). */
  isImpersonating: boolean;
  /** Who is acting, or null. */
  actor: ImpersonationActor | null;
  /** The impersonator's own session is kept on this browser and can be resumed. */
  canReturnToAdmin: boolean;
  /** End the impersonation; resumes the impersonator's own session when there is one. */
  endImpersonation(): Promise<EndImpersonationResult>;
}

/** The impersonation state of the active session, and "return to admin". */
export function useImpersonation(): UseImpersonationReturn {
  const { claims, session, endImpersonation } = useAtlas();
  const actor = actorFromClaims(claims) ?? session?.actor ?? null;
  return {
    isImpersonating: actor !== null,
    actor,
    canReturnToAdmin: actor !== null && Boolean(session?.actor_session_id),
    endImpersonation,
  };
}

export interface ImpersonationBannerProps {
  /** Called after the impersonation ended, with the outcome. */
  onEnded?: (result: EndImpersonationResult) => void;
}

/**
 * A banner shown only while the active session is an impersonation: it names
 * the user being acted as, and offers "Return to admin" (resume the
 * impersonator's own session) or, with no session to return to, "End
 * impersonation". Renders nothing on an ordinary session.
 */
export function ImpersonationBanner({ onEnded }: ImpersonationBannerProps) {
  const { user } = useAtlas();
  const { isImpersonating, canReturnToAdmin, endImpersonation } = useImpersonation();
  const t = useText();
  const cls = useClasses();
  const [busy, setBusy] = useState(false);
  if (!isImpersonating) return null;

  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.username ||
    user?.email_addresses?.find((e) => e.primary)?.email_address ||
    user?.id ||
    '';

  return (
    <div className={cls('alert', 'atlas-alert atlas-impersonation-banner')} role="status">
      <span className={cls('text', 'atlas-text')}>{t('impersonation.banner', { name })}</span>{' '}
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await endImpersonation();
            onEnded?.(result);
          } finally {
            setBusy(false);
          }
        }}
      >
        {canReturnToAdmin ? t('impersonation.returnToAdmin') : t('impersonation.end')}
      </button>
    </div>
  );
}
