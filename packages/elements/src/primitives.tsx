/**
 * The shared, unstyled primitives: `<Field>` and its `Label` / `Input` / `Error`
 * parts. They work inside both `<SignIn.Root>` and `<SignUp.Root>` because they
 * read the one shared flow context.
 *
 * Every primitive renders a BARE DOM element with no styles and no class names,
 * or — via `asChild` — merges its behaviour onto an element you supply, so the
 * markup and styling are entirely yours. That is the whole point of a headless
 * library: Atlas owns the auth state machine; you own every pixel.
 */

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useFlowContext } from './context';
import { bindField } from './machine';

/**
 * Minimal Radix-style `asChild`: merge props onto the single child element
 * instead of rendering our own wrapper. `className` and `style` are merged;
 * event handlers are composed (ours runs, then yours). Falls back to a default
 * element when `asChild` is off.
 */
export function Slot<P extends object>({
  asChild,
  defaultElement,
  props,
  children,
}: {
  asChild?: boolean;
  defaultElement: (p: P) => ReactElement;
  props: P;
  children: ReactNode;
}): ReactElement | null {
  if (asChild) {
    const only = Children.only(children);
    if (!isValidElement(only)) {
      throw new Error('asChild expects a single React element child.');
    }
    const childProps = only.props as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...(props as Record<string, unknown>) };

    for (const key of Object.keys(childProps)) {
      const ours = (props as Record<string, unknown>)[key];
      const theirs = childProps[key];
      if (key === 'className') {
        merged.className = [ours, theirs].filter(Boolean).join(' ') || undefined;
      } else if (key === 'style') {
        merged.style = { ...(ours as object), ...(theirs as object) };
      } else if (typeof ours === 'function' && typeof theirs === 'function') {
        // Compose handlers: our behaviour first, then the child's own.
        merged[key] = (...args: unknown[]) => {
          (ours as (...a: unknown[]) => void)(...args);
          (theirs as (...a: unknown[]) => void)(...args);
        };
      } else if (theirs !== undefined) {
        merged[key] = theirs;
      }
    }
    return cloneElement(only, merged);
  }
  return defaultElement(props);
}

/** The field a `<Field.*>` part belongs to, plus its resolved binding/ids. */
interface FieldContextValue {
  name: string;
  value: string;
  error: ReturnType<typeof bindField>['error'];
  onChange(next: string): void;
  inputId: string;
  errorId: string;
}

const FieldContext = createContext<FieldContextValue | null>(null);

function useField(part: string): FieldContextValue {
  const value = useContext(FieldContext);
  if (!value) throw new Error(`<Field.${part}> must be used inside a <Field>.`);
  return value;
}

export interface FieldProps {
  /** The field key — e.g. `identifier`, `password`, `code`, `email`. */
  name: string;
  children: ReactNode;
}

/**
 * Scopes a field: binds `name` to the running flow's collected values + errors,
 * and provides that binding (plus a generated input/error id pair for a11y) to
 * the `Label` / `Input` / `Error` parts nested inside it. Renders no DOM of its
 * own — it is a context boundary.
 */
export function Field({ name, children }: FieldProps) {
  const flow = useFlowContext();
  const binding = bindField(name, flow.values, flow.setValue, flow.errors);
  const inputId = useId();
  const errorId = useId();
  return (
    <FieldContext.Provider
      value={{
        name,
        value: binding.value,
        error: binding.error,
        onChange: binding.onChange,
        inputId,
        errorId,
      }}
    >
      {children}
    </FieldContext.Provider>
  );
}

export interface FieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  asChild?: boolean;
  children?: ReactNode;
}

/** A `<label>` wired (via `htmlFor`) to the field's input. */
export function FieldLabel({ asChild, children, ...rest }: FieldLabelProps) {
  const field = useField('Label');
  return (
    <Slot
      asChild={asChild}
      props={{ ...rest, htmlFor: rest.htmlFor ?? field.inputId }}
      defaultElement={(p) => <label {...p}>{children}</label>}
    >
      {children}
    </Slot>
  );
}

export interface FieldInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'children'> {
  asChild?: boolean;
  /** With `asChild`, the single `<input>` element to merge the binding onto. */
  children?: ReactNode;
}

/**
 * A controlled `<input>` bound to the field: its `value` comes from the flow and
 * every keystroke writes straight back through the flow's `setValue`. Sensible
 * `type` defaults per field (password → password, code → one-time-code) can be
 * overridden with a plain `type` prop. No styles, no class names.
 */
export function FieldInput({ asChild, children, ...rest }: FieldInputProps) {
  const field = useField('Input');
  const defaultType =
    field.name === 'password' || field.name === 'secondCode'
      ? 'password'
      : field.name === 'code'
        ? 'text'
        : field.name === 'email' || field.name === 'identifier'
          ? 'email'
          : 'text';

  const props: InputHTMLAttributes<HTMLInputElement> = {
    id: field.inputId,
    name: field.name,
    type: defaultType,
    value: field.value,
    'aria-invalid': field.error ? true : undefined,
    'aria-describedby': field.error ? field.errorId : undefined,
    ...rest,
    onChange: (event: ChangeEvent<HTMLInputElement>) => field.onChange(event.target.value),
  };

  return (
    <Slot asChild={asChild} props={props} defaultElement={(p) => <input {...p} />}>
      {/* asChild expects the caller to pass the <input> as the single child. */}
      {children ?? <input />}
    </Slot>
  );
}

export interface FieldErrorProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  asChild?: boolean;
  /** Render-prop form: receive the `{ code, message }` and render your own node. */
  children?: ReactNode | ((error: { code: string; message: string }) => ReactNode);
}

/**
 * Renders the field's error message, or nothing when the field has no error.
 * Supports a render-prop child so you can style per error code. The element
 * carries `role="alert"` and the id the input points `aria-describedby` at.
 */
export function FieldError({ asChild, children, ...rest }: FieldErrorProps) {
  const field = useField('Error');
  if (!field.error) return null;

  const content =
    typeof children === 'function'
      ? children({ code: field.error.code, message: field.error.message })
      : (children ?? field.error.message);

  const props: HTMLAttributes<HTMLElement> = {
    id: field.errorId,
    role: 'alert',
    ...rest,
  };

  return (
    <Slot asChild={asChild} props={props} defaultElement={(p) => <span {...p}>{content}</span>}>
      <span>{content}</span>
    </Slot>
  );
}

/** Clerk-Elements-style attachment of the parts onto `Field`. */
Field.Label = FieldLabel;
Field.Input = FieldInput;
Field.Error = FieldError;
