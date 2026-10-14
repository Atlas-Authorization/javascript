/**
 * `@atlasauth/elements/sign-up` — the sign-up compound component.
 *
 * ```tsx
 * import { AtlasProvider } from '@atlasauth/react';
 * import * as SignUp from '@atlasauth/elements/sign-up';
 * import { Field } from '@atlasauth/elements';
 *
 * <AtlasProvider publishableKey={pk} frontendApi="https://atlasauth.net">
 *   <SignUp.Root afterUrl="/welcome">
 *     <SignUp.Step name="start">
 *       <Field name="email"><Field.Label>Email</Field.Label><Field.Input /><Field.Error /></Field>
 *       <Field name="password"><Field.Label>Password</Field.Label><Field.Input /><Field.Error /></Field>
 *       <SignUp.Action action="submit">Create account</SignUp.Action>
 *       <SignUp.Connection provider="google">Sign up with Google</SignUp.Connection>
 *     </SignUp.Step>
 *
 *     <SignUp.Step name="verifications">
 *       <Field name="code"><Field.Label>Code</Field.Label><Field.Input /><Field.Error /></Field>
 *       <SignUp.Action action="submit">Verify</SignUp.Action>
 *       <SignUp.Action action="resend">Resend code</SignUp.Action>
 *     </SignUp.Step>
 *   </SignUp.Root>
 * </AtlasProvider>
 * ```
 */

import { Action, Step, Strategy, makeOauthButton, makeRoot } from './flow-parts';

export const Root = makeRoot('sign-up');
export { Step, Action, Strategy };

/** A per-provider social sign-up button (the `oauth_<provider>` strategy). */
export const Connection = makeOauthButton();
