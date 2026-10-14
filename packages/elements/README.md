# @atlasauth/elements

Headless, unstyled, composable React primitives for building a **fully custom**
Atlas sign-in / sign-up UI. The Atlas peer of `@clerk/elements`.

Atlas owns the auth state machine — the server returns a `status` and these
primitives render whatever step that status maps to. You own every pixel: each
primitive renders a bare DOM element (or merges onto your own element via
`asChild`), with **no styles and no class names**.

```bash
pnpm add @atlasauth/elements @atlasauth/react
```

It is driven by `<AtlasProvider>` from `@atlasauth/react`, which must wrap your
app (it holds the publishable key, the session, and the FAPI origin).

## Concepts

- `SignIn.Root` / `SignUp.Root` — start the attempt flow and provide its context.
  Optional `afterUrl` sends the user on once the flow completes.
- `SignIn.Step name="start | first-factor | second-factor | mfa-enrollment | verifications | reset-password | sso-callback | complete | error"` —
  renders its children **only** when the server's current status resolves to that
  step. Exactly one step is live at a time, and the server picks it — never the
  client.
- `Field name="identifier | password | code | email | …"` with `Field.Label`,
  `Field.Input`, `Field.Error` — a controlled input bound to the flow's collected
  values, with the attempt's error for that field surfaced inline.
- `SignIn.Action action="submit | resend | navigate"` — a bare `<button>` that
  fires the right attempt method. `submit` advances the attempt; `resend`
  re-sends an emailed code; `navigate` routes.
- `SignIn.Strategy name="password | email_code | passkey | oauth_<provider>"` —
  renders its children only when that strategy is available for the current
  attempt (the server's `supported_first_factors`, or social / passkey on the
  start screen).
- `SignIn.Connection provider="google"` / `SignIn.PasskeyButton` — convenience
  buttons that begin a social or passkey sign-in.

Every primitive also accepts `asChild` (merge behaviour onto your own element) or
a render-prop child, so the markup is entirely yours.

## Full example

```tsx
import { AtlasProvider } from '@atlasauth/react';
import * as SignIn from '@atlasauth/elements/sign-in';
import { Field } from '@atlasauth/elements';

export function CustomSignIn() {
  return (
    <AtlasProvider publishableKey={PK} frontendApi="https://atlasauth.net">
      <SignIn.Root afterUrl="/dashboard">
        {/* 1. identifier + social + passkey */}
        <SignIn.Step name="start">
          <Field name="identifier">
            <Field.Label>Email</Field.Label>
            <Field.Input />
            <Field.Error />
          </Field>
          <SignIn.Action action="submit">Continue</SignIn.Action>

          <SignIn.Connection provider="google">Continue with Google</SignIn.Connection>
          <SignIn.Strategy name="passkey">
            <SignIn.PasskeyButton>Use a passkey</SignIn.PasskeyButton>
          </SignIn.Strategy>
        </SignIn.Step>

        {/* 2. first factor — render the strategy the server offers */}
        <SignIn.Step name="first-factor">
          <SignIn.Strategy name="password">
            <Field name="password">
              <Field.Label>Password</Field.Label>
              <Field.Input />
              <Field.Error />
            </Field>
          </SignIn.Strategy>
          <SignIn.Strategy name="email_code">
            <Field name="code">
              <Field.Label>Emailed code</Field.Label>
              <Field.Input />
              <Field.Error />
            </Field>
            <SignIn.Action action="resend">Resend code</SignIn.Action>
          </SignIn.Strategy>
          <SignIn.Action action="submit">Sign in</SignIn.Action>
        </SignIn.Step>

        {/* 3. second factor */}
        <SignIn.Step name="second-factor">
          <Field name="code">
            <Field.Label>Authentication code</Field.Label>
            <Field.Input />
            <Field.Error />
          </Field>
          <SignIn.Action action="submit">Verify</SignIn.Action>
        </SignIn.Step>

        {/* 4. a status this build doesn't know → an honest fallback, never blank */}
        <SignIn.Step name="error">
          <p role="alert">Please update the app and try again.</p>
        </SignIn.Step>
      </SignIn.Root>
    </AtlasProvider>
  );
}
```

Sign-up is identical in shape under `@atlasauth/elements/sign-up` — a `start` step
collecting `email` + `password`, then a `verifications` step for the emailed code.

## Building your own primitive

The flow context and the pure state machine are exported, so you can build
anything the built-in parts don't cover:

```tsx
import { useFlowContext, stepMatches, bindField } from '@atlasauth/elements';
```

## License

MIT
