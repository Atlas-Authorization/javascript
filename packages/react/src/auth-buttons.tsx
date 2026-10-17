'use client';

import { useEffect, type ReactNode } from 'react';
import { useAuth } from './hooks';
import { navigateTo, useText, withRedirect } from './components-shared';

export interface AuthButtonProps {
  /** Where the sign-in / sign-up page lives. Defaults to `/sign-in` / `/sign-up`. */
  url?: string;
  /** Where to return after auth completes (becomes `?redirect_url=`). */
  redirectUrl?: string;
  children?: ReactNode;
  className?: string;
}

/** Clerk-parity ergonomic: a button that sends the user to your sign-in page. */
export function SignInButton({ url = '/sign-in', redirectUrl, children, className }: AuthButtonProps) {
  const t = useText();
  return (
    <button type="button" className={className} onClick={() => navigateTo(withRedirect(url, redirectUrl))}>
      {children ?? t('signIn.title')}
    </button>
  );
}

/** Clerk-parity ergonomic: a button that sends the user to your sign-up page. */
export function SignUpButton({ url = '/sign-up', redirectUrl, children, className }: AuthButtonProps) {
  const t = useText();
  return (
    <button type="button" className={className} onClick={() => navigateTo(withRedirect(url, redirectUrl))}>
      {children ?? t('signIn.signUpLink')}
    </button>
  );
}

/** Clerk-parity ergonomic: a button that signs the user out, then optionally redirects. */
export function SignOutButton({
  redirectUrl,
  children,
  className,
}: {
  redirectUrl?: string;
  children?: ReactNode;
  className?: string;
}) {
  const { signOut } = useAuth();
  const t = useText();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void signOut().then(() => {
          if (redirectUrl) navigateTo(redirectUrl);
        });
      }}
    >
      {children ?? t('userButton.signOut')}
    </button>
  );
}

/** Declarative "render this to send the user to sign-in" (Clerk `<RedirectToSignIn>`). */
export function RedirectToSignIn({ url = '/sign-in', redirectUrl }: { url?: string; redirectUrl?: string }) {
  useEffect(() => navigateTo(withRedirect(url, redirectUrl), true), [url, redirectUrl]);
  return null;
}

/** Declarative "render this to send the user to sign-up" (Clerk `<RedirectToSignUp>`). */
export function RedirectToSignUp({ url = '/sign-up', redirectUrl }: { url?: string; redirectUrl?: string }) {
  useEffect(() => navigateTo(withRedirect(url, redirectUrl), true), [url, redirectUrl]);
  return null;
}
