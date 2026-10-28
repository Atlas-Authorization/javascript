import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PolicyAcceptanceController, type Policy } from '@atlasauth/js';
import { AtlasProvider } from '@atlasauth/react';
import { FlowProvider, type FlowContextValue } from './context';
import { Action, Policies, Step } from './flow-parts';
import { stepForAttempt, stepMatches } from './machine';

afterEach(() => cleanup());

const policy = (over: Partial<Policy> = {}): Policy => ({
  key: 'tos',
  title: 'Terms of Service',
  display: 'checkbox',
  required: true,
  appliesTo: 'sign_up',
  versionId: 'polv_1',
  version: '1',
  contentHtml: '<p>Terms body</p>',
  contentMarkdown: null,
  contentUrl: null,
  contentSha256: 'h',
  effectiveAt: null,
  summaryOfChanges: null,
  reaccept: null,
  ...over,
});

function makeFlow(controller: PolicyAcceptanceController, over: Partial<FlowContextValue> = {}): FlowContextValue {
  return {
    mode: 'sign-up',
    attempt: null,
    errors: [],
    busy: false,
    values: {},
    setValue: vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
    resend: vi.fn().mockResolvedValue(undefined),
    startOauth: vi.fn().mockResolvedValue(undefined),
    startPasskey: vi.fn().mockResolvedValue(undefined),
    policies: controller,
    policiesSatisfied: controller.canSubmit(),
    ...over,
  };
}

function wrap(flow: FlowContextValue, ui: React.ReactNode) {
  return render(
    <AtlasProvider publishableKey="pk_test_x" frontendApi="https://fapi.example" fetchImpl={(async () => new Response('{}')) as unknown as typeof fetch}>
      <FlowProvider value={flow}>{ui}</FlowProvider>
    </AtlasProvider>,
  );
}

describe('the policies step', () => {
  it('maps needs_policy_acceptance onto the "policies" step', () => {
    expect(stepForAttempt({ id: 'sia_1', status: 'needs_policy_acceptance' })).toBe('policies');
    expect(stepMatches({ id: 'sia_1', status: 'needs_policy_acceptance' }, 'policies')).toBe(true);
    expect(stepMatches({ id: 'sia_1', status: 'needs_policy_acceptance' }, 'error')).toBe(false);
  });
});

describe('<SignUp.Policies>', () => {
  it('renders the combined checkbox, and the submit action is disabled until it is ticked', () => {
    const controller = new PolicyAcceptanceController([policy(), policy({ key: 'privacy', title: 'Privacy Policy', versionId: 'polv_2' })]);
    const flow = makeFlow(controller);
    wrap(
      flow,
      <Step name="start">
        <Policies />
        <Action action="submit">Create</Action>
      </Step>,
    );
    expect(screen.getByText('Terms of Service')).toBeTruthy();
    // Unticked required policies: the submit action is blocked.
    expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    controller.setAllChecked(true);
    wrap(makeFlow(controller), <Action action="submit">Create</Action>);
    expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(false);
  });

  it('supports a render-prop for custom markup', () => {
    const controller = new PolicyAcceptanceController([policy()]);
    wrap(
      makeFlow(controller),
      <Policies>
        {({ policies, controller: c }) => (
          <label>
            <input type="checkbox" data-testid="mine" onChange={(e) => c.setAllChecked(e.target.checked)} />
            {policies.map((p) => p.title).join(',')}
          </label>
        )}
      </Policies>,
    );
    fireEvent.click(screen.getByTestId('mine'));
    expect(controller.canSubmit()).toBe(true);
    expect(controller.build()[0]).toMatchObject({ policy: 'tos', display: 'checkbox' });
  });

  it('renders nothing when the instance has no policies', () => {
    const { container } = wrap(makeFlow(new PolicyAcceptanceController([])), <Policies />);
    expect(container.querySelector('[data-atlas-policies]')).toBeNull();
  });

  it('opens the unskippable dialog while reading, and submits once accepted', async () => {
    const controller = new PolicyAcceptanceController([policy({ display: 'scroll' })]);
    const setPolicyReading = vi.fn();
    const flow = makeFlow(controller, { policyReading: true, setPolicyReading });
    wrap(flow, <Policies />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(document.querySelector('[data-atlas-policy-accept]') as HTMLElement);
    expect(controller.isChecked('tos')).toBe(true);
  });
});
