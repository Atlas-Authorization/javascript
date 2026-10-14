/**
 * `@atlasauth/elements` — the Atlas peer of `@clerk/elements`.
 *
 * Headless, unstyled, composable React primitives that drive the Atlas sign-in /
 * sign-up attempt flow, so a team can build a fully custom auth UI while Atlas
 * owns the state machine. Pair with `<AtlasProvider>` from `@atlasauth/react`.
 *
 * - `import * as SignIn from '@atlasauth/elements/sign-in'`
 * - `import * as SignUp from '@atlasauth/elements/sign-up'`
 * - shared primitives (`Field`, `Slot`) and the pure machine from the root.
 */

// Shared, unstyled field primitives.
export { Field, FieldLabel, FieldInput, FieldError, Slot } from './primitives';
export type { FieldProps, FieldLabelProps, FieldInputProps, FieldErrorProps } from './primitives';

// The flow context + its hook, for building your own primitives.
export { useFlowContext } from './context';
export type { FlowContextValue } from './context';

// The pure state machine — step selection, field + action wiring. Exported so it
// can be reused (and so consumers can reason about the mapping) without React.
export {
  stepForAttempt,
  stepMatches,
  strategyAvailable,
  oauthProviderOf,
  fieldError,
  bindField,
  runAction,
  type StepName,
  type FlowMode,
  type ActionName,
  type FlowActions,
  type FieldBinding,
} from './machine';

// The two compound components, also available as subpath imports.
export * as SignIn from './sign-in';
export * as SignUp from './sign-up';
