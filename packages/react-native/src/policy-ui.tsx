import { createElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Linking, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import {
  policyTranslator,
  type Policy,
  type PolicyAcceptanceController,
  type PolicyAcceptancePayload,
  type PolicyT,
} from '@atlasauth/js';
import { useControllerTick, usePolicyGate, type UsePolicyGateResult } from './hooks';
import {
  ScrollEndTracker,
  renderPolicyAcceptStep,
  renderPolicyBanner,
  renderPolicyClickwrap,
  renderPolicyConsent,
  renderPolicyDocument,
  renderPolicyScrollModal,
  renderPolicyViewer,
  type PolicyPrimitives,
  type PolicyStyles,
} from './policy-render';

/*
 * Prebuilt React Native UI for policy acceptance (terms, privacy, any policy).
 * Each piece reads and writes a `PolicyAcceptanceController` (from
 * `usePolicies()` or `usePendingPolicies()`), the same state machine every
 * Atlas SDK shares, so they mix freely with your own screens:
 *
 *  - `<PolicyConsent>`    the checkbox(es) for a sign-up form, with an in-app document viewer;
 *  - `<PolicyClickwrap>`  the "By continuing you agree to ..." sentence for `link` policies;
 *  - `<PolicyScrollHost>` the unskippable scroll-to-accept modal for `scroll` policies;
 *  - `<PolicyAcceptStep>` the step a held sign-in shows (`needs_policy_acceptance`);
 *  - `<PolicyGate>`       the banner + re-accept flow for a signed-in user.
 *
 * Documents are drawn natively from the server's sanitised HTML; nothing is
 * rendered in a web view.
 */

const ui: PolicyPrimitives = { View, Text, Pressable, ScrollView, Modal };

/** Props every policy component takes. */
export interface PolicyUiProps {
  /** Override any `policy.*` string (a translation, different wording). */
  strings?: Record<string, string>;
  /** Style objects merged over the defaults. */
  styles?: PolicyStyles;
  /** Open a document link; defaults to `Linking.openURL`. */
  onLink?: (href: string) => void;
}

function usePolicyText(strings: Record<string, string> | undefined): PolicyT {
  return useMemo(
    () =>
      policyTranslator((key, vars) => {
        const template = strings?.[key];
        return template ? template.replace(/\{(\w+)\}/g, (m, n: string) => vars?.[n] ?? m) : '';
      }),
    [strings],
  );
}

const openLink = (href: string): void => {
  void Linking.openURL(href).catch(() => undefined);
};

/** A policy document drawn natively from sanitised HTML (`policy.contentHtml`). */
export function PolicyDocument(props: { html: string } & Pick<PolicyUiProps, 'styles' | 'onLink'>): ReactElement {
  return renderPolicyDocument(ui, props.html, props.onLink ?? openLink, props.styles);
}

/** The in-app viewer for whichever document `controller` has open (`controller.openDocument(key)`). */
export function PolicyViewer(props: { controller: PolicyAcceptanceController } & PolicyUiProps): ReactElement | null {
  const { controller } = props;
  useControllerTick(controller);
  const t = usePolicyText(props.strings);
  const key = controller.viewing?.key ?? null;
  const tracker = useMemo(
    () => new ScrollEndTracker(() => key && controller.markScrolledToEnd(key)),
    [controller, key],
  );
  return renderPolicyViewer(ui, controller, t, props.onLink ?? openLink, tracker, props.styles);
}

/**
 * The agreement checkbox(es) for a sign-up form: one combined "I agree to the A
 * and B" box (or one each with `usePolicies({ combined: false })`) for the
 * `checkbox` policies. Tapping a title opens the document in the in-app viewer.
 * Enable your submit button with `canSubmit`. Pass `viewer={false}` when another
 * policy component on the same screen already hosts the `<PolicyViewer>`.
 */
export function PolicyConsent(props: { controller: PolicyAcceptanceController; viewer?: boolean } & PolicyUiProps): ReactElement {
  const { controller } = props;
  useControllerTick(controller);
  const t = usePolicyText(props.strings);
  return createElement(
    View,
    null,
    renderPolicyConsent(ui, controller, t, props.styles),
    props.viewer === false ? null : createElement(PolicyViewer, props),
  );
}

/**
 * The clickwrap sentence for `link` policies ("By continuing you agree to the A
 * and B"), meant to sit under the submit button: submitting accepts them. Draws
 * nothing when there are none.
 */
export function PolicyClickwrap(props: { controller: PolicyAcceptanceController; viewer?: boolean } & PolicyUiProps): ReactElement {
  const { controller } = props;
  useControllerTick(controller);
  const t = usePolicyText(props.strings);
  return createElement(
    View,
    null,
    renderPolicyClickwrap(ui, controller, t, props.styles),
    props.viewer === false ? null : createElement(PolicyViewer, props),
  );
}

/**
 * The unskippable modal for one `scroll` policy: the hardware back button is
 * swallowed, Accept turns on only once the end of the text has been seen (or at
 * once when the text fits), and Decline cancels.
 */
export function PolicyScrollModal(
  props: {
    controller: PolicyAcceptanceController;
    policy: Policy;
    onAccept: () => void;
    onDecline: () => void;
  } & PolicyUiProps,
): ReactElement {
  const { controller, policy } = props;
  const t = usePolicyText(props.strings);
  const [atEnd, setAtEnd] = useState(false);
  const tracker = useMemo(
    () =>
      new ScrollEndTracker(() => {
        controller.markScrolledToEnd(policy.key);
        setAtEnd(true);
      }),
    [controller, policy.key, policy.versionId],
  );
  useEffect(() => {
    controller.startClock(policy.key);
    return () => controller.stopClock(policy.key);
  }, [controller, policy.key, policy.versionId]);
  return renderPolicyScrollModal(
    ui,
    policy,
    { atEnd },
    t,
    {
      onAccept: props.onAccept,
      onDecline: props.onDecline,
      onScroll: tracker.onScroll,
      onLayout: tracker.onLayout,
      onContentSizeChange: tracker.onContentSizeChange,
      onLink: props.onLink ?? openLink,
    },
    props.styles,
  );
}

/**
 * Walks the `scroll` policies one modal at a time while `active` is true: each
 * `<PolicyScrollModal>` accepts into the controller, and when none are left
 * `onDone` is called (send the sign-up, or accept the held sign-in, then).
 * Declining any of them calls `onDecline` with that policy and stops.
 */
export function PolicyScrollHost(
  props: {
    controller: PolicyAcceptanceController;
    active: boolean;
    onDone: () => void;
    onDecline: (policy: Policy) => void;
  } & PolicyUiProps,
): ReactElement | null {
  const { controller, active, onDone } = props;
  useControllerTick(controller);
  const next = active ? controller.pendingScroll() : null;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (active && !next) done.current();
  }, [active, next]);
  if (!active || !next) return null;
  return createElement(PolicyScrollModal, {
    key: next.versionId,
    controller,
    policy: next,
    onAccept: () => controller.acceptScroll(next.key),
    onDecline: () => props.onDecline(next),
    strings: props.strings,
    styles: props.styles,
    onLink: props.onLink,
  });
}

/**
 * The step a sign-in shows when the server holds the attempt at
 * `needs_policy_acceptance`: the policies to accept (checkboxes, the clickwrap
 * sentence, and scroll modals on submit), then `onSubmit` gets the
 * `policy_acceptances` to send with `useSignIn().acceptPolicies(...)`.
 * `onDecline` abandons the sign-in.
 *
 * ```tsx
 * const { controller } = usePendingPolicies(result);   // result: the FlowResult that was held
 * controller && <PolicyAcceptStep controller={controller} busy={busy}
 *   onSubmit={(acceptances) => acceptPolicies({ attemptId: result.attemptId!, policyToken: result.policyToken, acceptances })}
 *   onDecline={cancel} />
 * ```
 */
export function PolicyAcceptStep(
  props: {
    controller: PolicyAcceptanceController;
    onSubmit: (acceptances: PolicyAcceptancePayload[]) => void;
    onDecline: () => void;
    busy?: boolean;
  } & PolicyUiProps,
): ReactElement {
  const { controller } = props;
  useControllerTick(controller);
  const t = usePolicyText(props.strings);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = () => {
    setMessage(null);
    if (controller.pendingScroll()) setReading(true);
    else props.onSubmit(controller.build());
  };
  return createElement(
    View,
    null,
    renderPolicyAcceptStep(ui, controller, t, { busy: props.busy, message }, { onSubmit: submit, onDecline: props.onDecline }, props.styles),
    createElement(PolicyViewer, props),
    createElement(PolicyScrollHost, {
      controller,
      active: reading,
      strings: props.strings,
      styles: props.styles,
      onLink: props.onLink,
      onDone: () => {
        setReading(false);
        props.onSubmit(controller.build());
      },
      onDecline: (policy: Policy) => {
        setReading(false);
        setMessage(t('policy.declined', { policy: policy.title }));
        props.onDecline();
      },
    }),
  );
}

/**
 * The banner and re-acceptance modal over a `gate` (what `usePolicyGate()`
 * returns). Use it directly when your provider is not this package's (the Expo
 * package does); otherwise use {@link PolicyGate}.
 */
export function PolicyGateView(
  props: { gate: UsePolicyGateResult; children?: ReactNode; onAccepted?: () => void } & PolicyUiProps,
): ReactElement {
  const { gate } = props;
  const t = usePolicyText(props.strings);
  const [controller, setController] = useState<PolicyAcceptanceController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = () => {
    setBusy(true);
    setError(null);
    gate
      .begin()
      .then((c) => setController(c))
      .catch(() => setError(t('policy.requiredGeneric')))
      .finally(() => setBusy(false));
  };
  const accept = (c: PolicyAcceptanceController) => {
    setBusy(true);
    void gate
      .accept(c)
      .then((res) => {
        if (!res.ok) {
          setError(res.errors[0]?.message ?? t('policy.requiredGeneric'));
          return;
        }
        setController(null);
        props.onAccepted?.();
      })
      .finally(() => setBusy(false));
  };
  const strings = { ...props.strings, 'policy.pendingTitle': t('policy.bannerTitle'), 'policy.pendingIntro': t('policy.reacceptIntro') };
  return createElement(
    View,
    null,
    gate.pending.length > 0
      ? renderPolicyBanner(ui, gate.pending.map((p) => p.title), gate.graceEndsAt, t, { onReview: review }, { busy, error }, props.styles)
      : null,
    controller
      ? createElement(
          Modal,
          { visible: true, animationType: 'slide', onRequestClose: () => setController(null) },
          createElement(
            View,
            { style: { flex: 1, padding: 16, paddingTop: 48, backgroundColor: '#fff' } },
            createElement(PolicyAcceptStep, {
              controller,
              busy,
              strings,
              styles: props.styles,
              onLink: props.onLink,
              onSubmit: () => accept(controller),
              onDecline: () => setController(null),
            }),
          ),
        )
      : null,
    props.children,
  );
}

/**
 * A banner for a signed-in user whose policies need re-accepting (a newer
 * version is in force, perhaps with a grace window). Draws nothing when there is
 * nothing to accept; renders `children` always. "Review and accept" opens the
 * acceptance step in a modal and posts `POST /v1/client/me/policies/accept`.
 */
export function PolicyGate(props: { children?: ReactNode; onAccepted?: () => void } & PolicyUiProps): ReactElement {
  const gate = usePolicyGate();
  return createElement(PolicyGateView, { ...props, gate });
}
