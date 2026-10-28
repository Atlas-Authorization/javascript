/**
 * `<Passkey.*>`: headless passkey registration / login for a user store you
 * own, backed by the Atlas Passkey API through YOUR backend. It needs no Atlas
 * session and no `<AtlasProvider>`; you own the markup, Atlas owns the ceremony.
 *
 *   import * as Passkey from '@atlasauth/elements/passkey';
 *   <Passkey.Root endpoints={{ registrationInit, registrationFinalize, loginInit, loginFinalize }}
 *                 onSuccess={(result, kind) => …}>
 *     <Passkey.Register>Add a passkey</Passkey.Register>
 *     <Passkey.Login>Sign in with a passkey</Passkey.Login>
 *     <Passkey.Error />
 *   </Passkey.Root>
 */
import { createContext, useCallback, useContext, useMemo, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import {
  loginWithExternalPasskey,
  passkeysSupported,
  registerExternalPasskey,
  type ExternalPasskeyEndpoints,
  type WebAuthnHost,
} from '@atlasauth/js';
import { Slot } from './primitives';

export type PasskeyKind = 'register' | 'login';

interface PasskeyContextValue {
  busy: boolean;
  error: string | null;
  supported: boolean;
  register(name?: string): Promise<void>;
  login(): Promise<void>;
}

const Ctx = createContext<PasskeyContextValue | null>(null);

function usePasskey(): PasskeyContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('Passkey parts must be rendered inside <Passkey.Root>.');
  return v;
}

export interface RootProps {
  endpoints: ExternalPasskeyEndpoints;
  onSuccess?: (result: unknown, kind: PasskeyKind) => void;
  onError?: (error: Error, kind: PasskeyKind) => void;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Injectable WebAuthn host (tests). */
  host?: WebAuthnHost;
  children?: ReactNode;
}

export function Root({ endpoints, onSuccess, onError, fetch: f, headers, host, children }: RootProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (kind: PasskeyKind, fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn();
        onSuccess?.(result, kind);
      } catch (e) {
        const err = e instanceof Error ? e : new Error('Passkey request failed.');
        setError(err.message);
        onError?.(err, kind);
      } finally {
        setBusy(false);
      }
    },
    [onSuccess, onError],
  );

  const value = useMemo<PasskeyContextValue>(() => {
    const opts = { endpoints, fetch: f, headers, host };
    return {
      busy,
      error,
      supported: host ? true : passkeysSupported(),
      register: (name) => run('register', () => registerExternalPasskey(opts, { name })),
      login: () => run('login', () => loginWithExternalPasskey(opts)),
    };
  }, [busy, error, endpoints, f, headers, host, run]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean };

function action(label: 'register' | 'login') {
  return function ActionButton({ asChild, children, onClick, disabled, ...rest }: ButtonProps & { name?: string }) {
    const p = usePasskey();
    const props = {
      type: 'button' as const,
      ...rest,
      disabled: disabled || p.busy || !p.supported,
      'data-busy': p.busy ? '' : undefined,
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        if (!e.defaultPrevented) void (label === 'register' ? p.register() : p.login());
      },
    };
    return (
      <Slot asChild={asChild} defaultElement={(pp) => <button {...pp}>{children}</button>} props={props}>
        {children}
      </Slot>
    );
  };
}

/** Starts registration for the user your backend has signed in. */
export const Register = action('register');
/** Starts a passkey login. */
export const Login = action('login');

/** Renders the last error message (nothing while there is none). */
function ErrorMessage({ asChild, children, ...rest }: HTMLAttributes<HTMLElement> & { asChild?: boolean }) {
  const { error } = usePasskey();
  if (!error) return null;
  const props = { role: 'alert', ...rest };
  return (
    <Slot asChild={asChild} defaultElement={(pp) => <p {...pp}>{children ?? error}</p>} props={props}>
      {children ?? error}
    </Slot>
  );
}

export { ErrorMessage as Error };

/** Mounts its children only when the browser supports passkeys. */
export function Supported({ children }: { children?: ReactNode }) {
  return usePasskey().supported ? <>{children}</> : null;
}
