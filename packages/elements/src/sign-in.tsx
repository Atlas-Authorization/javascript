/**
 * `@atlasauth/elements/sign-in` — the sign-in compound component.
 *
 * ```tsx
 * import { AtlasProvider } from '@atlasauth/react';
 * import * as SignIn from '@atlasauth/elements/sign-in';
 * import { Field } from '@atlasauth/elements';
 *
 * <AtlasProvider publishableKey={pk} frontendApi="https://atlasauth.net">
 *   <SignIn.Root afterUrl="/dashboard">
 *     <SignIn.Step name="start">
 *       <Field name="identifier">
 *         <Field.Label>Email</Field.Label>
 *         <Field.Input />
 *         <Field.Error />
 *       </Field>
 *       <SignIn.Action action="submit">Continue</SignIn.Action>
 *       <SignIn.Connection provider="google">Continue with Google</SignIn.Connection>
 *       <SignIn.Strategy name="passkey">
 *         <SignIn.PasskeyButton>Use a passkey</SignIn.PasskeyButton>
 *       </SignIn.Strategy>
 *     </SignIn.Step>
 *
 *     <SignIn.Step name="first-factor">
 *       <SignIn.Strategy name="password">
 *         <Field name="password">
 *           <Field.Label>Password</Field.Label>
 *           <Field.Input />
 *           <Field.Error />
 *         </Field>
 *       </SignIn.Strategy>
 *       <SignIn.Action action="submit">Sign in</SignIn.Action>
 *     </SignIn.Step>
 *
 *     <SignIn.Step name="second-factor">
 *       <Field name="code"><Field.Input /><Field.Error /></Field>
 *       <SignIn.Action action="submit">Verify</SignIn.Action>
 *     </SignIn.Step>
 *   </SignIn.Root>
 * </AtlasProvider>
 * ```
 */

import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useFlowContext } from './context';
import { Slot } from './primitives';
import { Action, Step, Strategy, makeOauthButton, makeRoot } from './flow-parts';
import { strategyAvailable } from './machine';

export const Root = makeRoot('sign-in');
export { Step, Action, Strategy };

/** A per-provider social sign-in button (the `oauth_<provider>` strategy). */
export const Connection = makeOauthButton();

/**
 * A bare `<button>` that begins the WebAuthn passkey sign-in. Renders only when
 * the passkey strategy is available for the current attempt.
 */
export function PasskeyButton({
  asChild,
  children,
  ...rest
}: { asChild?: boolean; children?: ReactNode } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick'
>) {
  const flow = useFlowContext('sign-in');
  if (!strategyAvailable(flow.attempt, 'passkey')) return null;
  const props: ButtonHTMLAttributes<HTMLButtonElement> = {
    type: 'button',
    ...rest,
    onClick: () => void flow.startPasskey(),
  };
  return (
    <Slot asChild={asChild} props={props} defaultElement={(p) => <button {...p}>{children}</button>}>
      <button>{children}</button>
    </Slot>
  );
}
