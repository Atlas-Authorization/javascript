'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  referralChallengeRequired,
  type FapiClient,
  type FlowCaptcha,
  type ReferralConsent,
} from '@atlasauth/js';

/**
 * Referral attribution in the prebuilt forms. Capture itself happens in the
 * FAPI client (every sign-in / sign-up start carries the visitor's referral);
 * this is the one piece a form draws: when the instance requires the bot
 * challenge for referred sign-ups and a referral code was captured, the form
 * shows its captcha even when it is otherwise off.
 *
 * `settingsKey` re-checks once the instance settings arrive (they carry the
 * referral config).
 */
export function useReferralChallenge(client: FapiClient, settingsKey: unknown): boolean {
  const [required, setRequired] = useState(false);
  useEffect(() => {
    let alive = true;
    void referralChallengeRequired(client).then((on) => {
      if (alive) setRequired(on);
    });
    return () => {
      alive = false;
    };
  }, [client, settingsKey]);
  return required;
}

/** `flow` switched on when `forced` and the instance has a provider to draw. */
export function forceCaptchaFlow(flow: FlowCaptcha | undefined, forced: boolean): FlowCaptcha | undefined {
  if (!forced || !flow || !flow.provider || flow.enabled) return flow;
  return { ...flow, enabled: true };
}

/**
 * A `referralConsent` prop that keeps its identity across renders (an inline
 * function would otherwise rebuild the FAPI client every render). The latest
 * prop value is read at each sign-in / sign-up start.
 */
export function useStableReferralConsent(consent: ReferralConsent | undefined): ReferralConsent | undefined {
  const ref = useRef(consent);
  ref.current = consent;
  const kind = consent === undefined ? undefined : typeof consent === 'function' ? 'fn' : String(consent);
  return useMemo<ReferralConsent | undefined>(
    () =>
      kind === undefined
        ? undefined
        : () => {
            const c = ref.current;
            return typeof c === 'function' ? c() : c;
          },
    [kind],
  );
}
