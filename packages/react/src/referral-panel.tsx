'use client';

import { createElement, useEffect, useRef } from 'react';
import { useAtlas } from './AtlasProvider';
import type { AtlasUser } from './types';

/** The Referalli preset's base URL; its widget script is served per merchant at `{base}/t/{trackingToken}/widget.js`. */
export const DEFAULT_REFERRAL_WIDGET_BASE = 'https://referalli.com';

/** The Referalli widget script for a merchant's tracking token. */
export function referralWidgetSrc(trackingToken: string, base: string = DEFAULT_REFERRAL_WIDGET_BASE): string {
  return `${base.replace(/\/+$/, '')}/t/${encodeURIComponent(trackingToken)}/widget.js`;
}

/** The tag the widget script registers (the Referalli preset). */
const WIDGET_TAG = 'referalli-referral-widget';

/** A user's referral code and link. */
export interface UserReferral {
  code: string;
  linkUrl: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The referral fields on a user: `public_metadata.referalli` (`code`, `link_url`),
 * else the attribution mirror's `public_metadata.referral.own_code`. Null without a code.
 */
export function referralFromUser(user: Pick<AtlasUser, 'public_metadata'> | null): UserReferral | null {
  const md = (user?.public_metadata ?? {}) as Record<string, unknown>;
  const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const own = rec(md.referalli);
  const code = str(own.code) ?? str(rec(md.referral).own_code);
  if (!code) return null;
  return { code, linkUrl: str(own.link_url) ?? str(own.linkUrl) };
}

/** `{ code, linkUrl }` for the signed-in user, or null when signed out or not enrolled. */
export function useReferral(): UserReferral | null {
  return referralFromUser(useAtlas().user);
}

const loading = new Map<string, Promise<void>>();

/** Load a script once per page. */
function loadScript(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(src);
        reject(new Error(`could not load ${src}`));
      };
      document.head.appendChild(el);
    });
    loading.set(src, p);
  }
  return p;
}

/**
 * Load the widget script and mount its element in `host`, with `getAuthToken`
 * set to the Atlas session token. Returns the teardown.
 * @internal
 */
export function mountReferralElement(
  host: HTMLElement,
  opts: { program: string; src: string; getAuthToken: () => Promise<string | null> },
): () => void {
  let alive = true;
  void loadScript(opts.src)
    .then(() => {
      if (!alive) return;
      const el = document.createElement(WIDGET_TAG) as HTMLElement & { getAuthToken?: () => Promise<string | null> };
      el.setAttribute('program', opts.program);
      el.setAttribute('auth', 'atlas');
      el.getAuthToken = opts.getAuthToken;
      host.replaceChildren(el);
    })
    .catch(() => undefined); // the panel just does not appear
  return () => {
    alive = false;
    host.replaceChildren();
  };
}

export interface ReferralPanelProps {
  /** The referral program id. */
  program: string;
  /** Your Referalli tracking token: the script is loaded from `https://referalli.com/t/<trackingToken>/widget.js`. */
  trackingToken?: string;
  /** The referral platform's widget script URL, when not the Referalli preset (overrides `trackingToken`). */
  src?: string;
  className?: string;
}

/**
 * The user's "refer a friend" panel from the referral platform's own widget,
 * authenticated with the Atlas session token (no server route). Renders
 * nothing while signed out.
 */
export function ReferralPanel({ program, trackingToken, src: srcProp, className }: ReferralPanelProps) {
  // The script is per merchant: without src or a tracking token there is nothing to load.
  const src = srcProp ?? (trackingToken ? referralWidgetSrc(trackingToken) : null);
  const { status, getToken } = useAtlas();
  const host = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const signedIn = status === 'signed_in';
  useEffect(() => {
    if (!signedIn || !host.current || !src) return;
    return mountReferralElement(host.current, { program, src, getAuthToken: () => tokenRef.current() });
  }, [signedIn, program, src]);
  return signedIn && src ? createElement('div', { ref: host, className }) : null;
}
