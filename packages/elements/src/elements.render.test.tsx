import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AttemptView, FieldError } from '@atlasauth/js';
import { FlowProvider, type FlowContextValue } from './context';
import { Field } from './primitives';
import { Step, Action, Strategy } from './flow-parts';

/**
 * Render-level proof that the primitives behave as the headless contract
 * promises, driven by a hand-built flow context (no network, no AtlasProvider):
 *   • a Step mounts its children only when it matches the server status,
 *   • a Field renders a controlled input and surfaces its attempt error,
 *   • an Action fires the right flow method.
 * These sit on top of the pure-function proofs in `machine.test.ts`.
 */

afterEach(() => cleanup());

function makeFlow(over: Partial<FlowContextValue> = {}): FlowContextValue {
  return {
    mode: 'sign-in',
    attempt: null,
    errors: [],
    busy: false,
    values: {},
    setValue: vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
    resend: vi.fn().mockResolvedValue(undefined),
    startOauth: vi.fn().mockResolvedValue(undefined),
    startPasskey: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const attempt = (status: string, extra: Partial<AttemptView> = {}): AttemptView => ({
  id: 'sia_test',
  status,
  ...extra,
});

describe('<Step> renders only when it matches the current status', () => {
  it('shows exactly the step the server status resolves to', () => {
    const flow = makeFlow({ attempt: attempt('needs_first_factor') });
    render(
      <FlowProvider value={flow}>
        <Step name="start">
          <div data-testid="start">start</div>
        </Step>
        <Step name="first-factor">
          <div data-testid="ff">first factor</div>
        </Step>
      </FlowProvider>,
    );
    expect(screen.queryByTestId('ff')).not.toBeNull();
    expect(screen.queryByTestId('start')).toBeNull();
  });

  it('shows the start step before any attempt exists', () => {
    render(
      <FlowProvider value={makeFlow({ attempt: null })}>
        <Step name="start">
          <div data-testid="start">start</div>
        </Step>
      </FlowProvider>,
    );
    expect(screen.queryByTestId('start')).not.toBeNull();
  });
});

describe('<Field> wires value/onChange and surfaces the attempt field error', () => {
  const errors: FieldError[] = [
    { code: 'form_password_incorrect', message: 'Wrong password', param: 'password' },
  ];

  it('renders a controlled input seeded from the flow values', () => {
    const flow = makeFlow({ values: { password: 'hunter2' } });
    render(
      <FlowProvider value={flow}>
        <Field name="password">
          <Field.Label>Password</Field.Label>
          <Field.Input />
          <Field.Error />
        </Field>
      </FlowProvider>,
    );
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.value).toBe('hunter2');
    expect(input.type).toBe('password');
  });

  it('calls setValue with (name, next) on change', () => {
    const flow = makeFlow();
    render(
      <FlowProvider value={flow}>
        <Field name="identifier">
          <Field.Label>Email</Field.Label>
          <Field.Input />
        </Field>
      </FlowProvider>,
    );
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    expect(flow.setValue).toHaveBeenCalledWith('identifier', 'a@b.com');
  });

  it('surfaces the field error (and nothing when there is none)', () => {
    render(
      <FlowProvider value={makeFlow({ errors })}>
        <Field name="password">
          <Field.Input />
          <Field.Error />
        </Field>
        <Field name="code">
          <Field.Input />
          <Field.Error />
        </Field>
      </FlowProvider>,
    );
    // The error for `password` renders with role="alert"; `code` has none.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe('Wrong password');
  });

  it('asChild merges onto a custom input element', () => {
    const flow = makeFlow({ values: { code: '42' } });
    render(
      <FlowProvider value={flow}>
        <Field name="code">
          <Field.Input asChild>
            <input data-testid="custom" placeholder="code" />
          </Field.Input>
        </Field>
      </FlowProvider>,
    );
    const input = screen.getByTestId('custom') as HTMLInputElement;
    expect(input.value).toBe('42');
    expect(input.placeholder).toBe('code');
    fireEvent.change(input, { target: { value: '99' } });
    expect(flow.setValue).toHaveBeenCalledWith('code', '99');
  });
});

describe('<Action> calls the right attempt method', () => {
  it('action="submit" fires submit()', () => {
    const flow = makeFlow({ attempt: attempt('needs_first_factor') });
    render(
      <FlowProvider value={flow}>
        <Action action="submit">Sign in</Action>
      </FlowProvider>,
    );
    fireEvent.click(screen.getByText('Sign in'));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(flow.resend).not.toHaveBeenCalled();
  });

  it('action="resend" fires resend()', () => {
    const flow = makeFlow({ attempt: attempt('needs_email_verification') });
    render(
      <FlowProvider value={flow}>
        <Action action="resend">Resend</Action>
      </FlowProvider>,
    );
    fireEvent.click(screen.getByText('Resend'));
    expect(flow.resend).toHaveBeenCalledOnce();
    expect(flow.submit).not.toHaveBeenCalled();
  });

  it('a submit action is disabled while the flow is busy', () => {
    const flow = makeFlow({ busy: true });
    render(
      <FlowProvider value={flow}>
        <Action action="submit">Go</Action>
      </FlowProvider>,
    );
    expect((screen.getByText('Go') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('<Strategy> renders only an available strategy', () => {
  it('offers the server supported_first_factors on a first-factor step', () => {
    const flow = makeFlow({
      attempt: attempt('needs_first_factor', { supported_first_factors: ['password'] }),
    });
    render(
      <FlowProvider value={flow}>
        <Strategy name="password">
          <div data-testid="pw">password form</div>
        </Strategy>
        <Strategy name="email_code">
          <div data-testid="code">code form</div>
        </Strategy>
      </FlowProvider>,
    );
    expect(screen.queryByTestId('pw')).not.toBeNull();
    expect(screen.queryByTestId('code')).toBeNull();
  });
});
