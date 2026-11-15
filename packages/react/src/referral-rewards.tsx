'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeReferralTerms, formatMoney, getReferralRewards, type ReferralRewardsSummary } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useMeClient } from './components-shared';

/**
 * The signed-in user's referral earnings: `summary` (their code and link, the reward terms, totals per status and the
 * latest rewards), or null until loaded and while signed out. `enabled` is false when the app has rewards off, so a page
 * can hide the section. Read only: rewards are created and granted by Atlas.
 */
export function useReferralRewards(opts: { limit?: number } = {}) {
  const { status } = useAtlas();
  const client = useMeClient();
  const [summary, setSummary] = useState<ReferralRewardsSummary | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const limit = opts.limit;

  const reload = useCallback(async () => {
    if (status !== 'signed_in') {
      setSummary(null);
      setIsLoaded(true);
      return;
    }
    setSummary(await getReferralRewards(client, { limit }));
    setIsLoaded(true);
  }, [client, status, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { isLoaded, summary, enabled: summary?.enabled ?? false, reload };
}

export interface ReferralRewardsProps {
  /** How many recent rewards to list (default 5). */
  limit?: number;
  locale?: string;
  className?: string;
}

/** A referrer's page section: their link, what a referral earns, and what they have earned so far. Renders nothing while rewards are off. */
export function ReferralRewards({ limit = 5, locale, className }: ReferralRewardsProps) {
  const { isLoaded, summary } = useReferralRewards({ limit });
  const [copied, setCopied] = useState(false);
  if (!isLoaded || !summary || !summary.enabled) return null;
  const terms = describeReferralTerms(summary.terms, locale);
  const granted = Object.entries(summary.totals.granted ?? {});
  const pending = Object.entries(summary.totals.pending ?? {});
  const link = summary.referralLink;
  return (
    <section className={className ?? 'atlas-referral-rewards'}>
      {terms ? <p className="atlas-referral-terms">{terms}</p> : null}
      {link ? (
        <p className="atlas-referral-link">
          <input readOnly value={link} aria-label="Your referral link" onFocus={(e) => e.currentTarget.select()} />{' '}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => undefined);
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </p>
      ) : null}
      <p className="atlas-referral-totals">
        Earned: {granted.length ? granted.map(([c, n]) => formatMoney(n, c, locale)).join(', ') : formatMoney(0, summary.terms?.currency ?? 'usd', locale)}
        {pending.length ? ` (pending: ${pending.map(([c, n]) => formatMoney(n, c, locale)).join(', ')})` : ''}
      </p>
      {summary.rewards.length ? (
        <ul className="atlas-referral-list">
          {summary.rewards.map((r) => (
            <li key={r.id}>
              {formatMoney(r.amount, r.currency, locale)} <span>{r.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
